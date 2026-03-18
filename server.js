/**
 * qwen3.5-scw-router — standalone Node.js server
 * Converts Anthropic API format ↔ OpenAI API format
 * Forwards to Scaleway genAPI with TLS bypass for internal CA certs.
 *
 * Usage:
 *   UPSTREAM_BASE_URL=https://api.scaleway.ai \
 *   node server.mjs
 *
 * Environment variables:
 *   PORT                 — listen port (default: 8787)
 *   UPSTREAM_BASE_URL    — upstream OpenAI-compatible endpoint (required)
 *   LOG_REQUESTS         — set to "true" to log full request/response bodies
 */

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

// ─── Configuration ───────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "8787", 10);
const UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL;
const LOG_REQUESTS = process.env.LOG_REQUESTS === "true";

if (!UPSTREAM_BASE_URL) {
  console.error("❌ UPSTREAM_BASE_URL is required. Example:");
  console.error("   UPSTREAM_BASE_URL=https://api.scaleway.ai node server.mjs");
  process.exit(1);
}

// ─── Model mapping ───────────────────────────────────────────────────────────

function mapModel(anthropicModel) {
  // Pass-through: the model name comes from Claude Code's ANTHROPIC_MODEL env var
  return anthropicModel;
}

// ─── Anthropic → OpenAI format conversion ────────────────────────────────────

function validateOpenAIToolCalls(messages) {
  const validated = [];

  for (let i = 0; i < messages.length; i++) {
    const cur = { ...messages[i] };

    if (cur.role === "assistant" && cur.tool_calls) {
      const validToolCalls = [];
      const immediateToolMsgs = [];
      let j = i + 1;
      while (j < messages.length && messages[j].role === "tool") {
        immediateToolMsgs.push(messages[j]);
        j++;
      }

      for (const tc of cur.tool_calls) {
        if (immediateToolMsgs.some((tm) => tm.tool_call_id === tc.id)) {
          validToolCalls.push(tc);
        }
      }

      if (validToolCalls.length > 0) {
        cur.tool_calls = validToolCalls;
      } else {
        delete cur.tool_calls;
      }

      if (cur.content || cur.tool_calls) validated.push(cur);
    } else if (cur.role === "tool") {
      let hasMatch = false;
      if (i > 0) {
        const prev = messages[i - 1];
        if (prev.role === "assistant" && prev.tool_calls) {
          hasMatch = prev.tool_calls.some((tc) => tc.id === cur.tool_call_id);
        } else if (prev.role === "tool") {
          for (let k = i - 1; k >= 0; k--) {
            if (messages[k].role === "tool") continue;
            if (messages[k].role === "assistant" && messages[k].tool_calls) {
              hasMatch = messages[k].tool_calls.some(
                (tc) => tc.id === cur.tool_call_id,
              );
            }
            break;
          }
        }
      }
      if (hasMatch) validated.push(cur);
    } else {
      validated.push(cur);
    }
  }

  return validated;
}

function formatAnthropicToOpenAI(body) {
  const { model, messages, system = [], temperature, tools, stream } = body;

  const openAIMessages = Array.isArray(messages)
    ? messages.flatMap((msg) => {
        const out = [];

        if (!Array.isArray(msg.content)) {
          if (typeof msg.content === "string") {
            out.push({ role: msg.role, content: msg.content });
          }
          return out;
        }

        if (msg.role === "assistant") {
          const assistantMsg = { role: "assistant", content: null };
          let text = "";
          const toolCalls = [];

          for (const part of msg.content) {
            if (part.type === "text") {
              text +=
                (typeof part.text === "string"
                  ? part.text
                  : JSON.stringify(part.text)) + "\n";
            } else if (part.type === "tool_use") {
              toolCalls.push({
                id: part.id,
                type: "function",
                function: {
                  name: part.name,
                  arguments: JSON.stringify(part.input),
                },
              });
            }
          }

          const trimmed = text.trim();
          if (trimmed) assistantMsg.content = trimmed;
          if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
          if (assistantMsg.content || assistantMsg.tool_calls?.length > 0) {
            out.push(assistantMsg);
          }
        } else if (msg.role === "user") {
          let userText = "";
          const toolMsgs = [];

          for (const part of msg.content) {
            if (part.type === "text") {
              userText +=
                (typeof part.text === "string"
                  ? part.text
                  : JSON.stringify(part.text)) + "\n";
            } else if (part.type === "tool_result") {
              toolMsgs.push({
                role: "tool",
                tool_call_id: part.tool_use_id,
                content:
                  typeof part.content === "string"
                    ? part.content
                    : JSON.stringify(part.content),
              });
            }
          }

          const trimmedUser = userText.trim();
          if (trimmedUser) out.push({ role: "user", content: trimmedUser });
          out.push(...toolMsgs);
        }

        return out;
      })
    : [];

  // Build system message — merge all system blocks into ONE message
  // (vLLM/Qwen backends require a single system message at the start)
  const mappedModel = mapModel(model);
  let systemText = "";
  if (Array.isArray(system)) {
    systemText = system.map((item) => item.text).join("\n\n");
  } else if (typeof system === "string" && system) {
    systemText = system;
  }

  const systemMessages = systemText
    ? [{ role: "system", content: systemText }]
    : [];

  const data = {
    model: mappedModel,
    messages: [...systemMessages, ...validateOpenAIToolCalls(openAIMessages)],
    temperature,
    stream,
  };

  if (tools) {
    data.tools = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  return data;
}

// ─── OpenAI → Anthropic format conversion (non-streaming) ───────────────────

function formatOpenAIToAnthropic(completion, model) {
  const messageId = "msg_" + Date.now();
  let content = [];

  const choice = completion.choices?.[0]?.message;
  if (!choice)
    return {
      id: messageId,
      type: "message",
      role: "assistant",
      content: [],
      stop_reason: "end_turn",
      stop_sequence: null,
      model,
    };

  if (choice.content) {
    content = [{ text: choice.content, type: "text" }];
  } else if (choice.tool_calls) {
    content = choice.tool_calls.map((item) => ({
      type: "tool_use",
      id: item.id,
      name: item.function?.name,
      input: item.function?.arguments
        ? JSON.parse(item.function.arguments)
        : {},
    }));
  }

  return {
    id: messageId,
    type: "message",
    role: "assistant",
    content,
    stop_reason:
      completion.choices[0].finish_reason === "tool_calls"
        ? "tool_use"
        : "end_turn",
    stop_sequence: null,
    model,
  };
}

// ─── OpenAI SSE → Anthropic SSE stream conversion ──────────────────────────

function streamOpenAIToAnthropic(upstreamRes, model, nodeRes) {
  const messageId = "msg_" + Date.now();

  const sendSSE = (eventType, data) => {
    nodeRes.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // message_start
  sendSSE("message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });

  let contentBlockIndex = 0;
  let hasStartedTextBlock = false;
  let isToolUse = false;
  let currentToolCallId = null;
  let buffer = "";

  function processDelta(delta) {
    // Handle tool calls
    if (delta.tool_calls?.length > 0) {
      for (const toolCall of delta.tool_calls) {
        const toolCallId = toolCall.id;

        if (toolCallId && toolCallId !== currentToolCallId) {
          if (isToolUse || hasStartedTextBlock) {
            sendSSE("content_block_stop", {
              type: "content_block_stop",
              index: contentBlockIndex,
            });
          }

          isToolUse = true;
          hasStartedTextBlock = false;
          currentToolCallId = toolCallId;
          contentBlockIndex++;

          sendSSE("content_block_start", {
            type: "content_block_start",
            index: contentBlockIndex,
            content_block: {
              type: "tool_use",
              id: toolCallId,
              name: toolCall.function?.name,
              input: {},
            },
          });
        }

        if (toolCall.function?.arguments && currentToolCallId) {
          sendSSE("content_block_delta", {
            type: "content_block_delta",
            index: contentBlockIndex,
            delta: {
              type: "input_json_delta",
              partial_json: toolCall.function.arguments,
            },
          });
        }
      }
    } else if (delta.content) {
      if (isToolUse) {
        sendSSE("content_block_stop", {
          type: "content_block_stop",
          index: contentBlockIndex,
        });
        isToolUse = false;
        currentToolCallId = null;
        contentBlockIndex++;
      }

      if (!hasStartedTextBlock) {
        sendSSE("content_block_start", {
          type: "content_block_start",
          index: contentBlockIndex,
          content_block: { type: "text", text: "" },
        });
        hasStartedTextBlock = true;
      }

      sendSSE("content_block_delta", {
        type: "content_block_delta",
        index: contentBlockIndex,
        delta: { type: "text_delta", text: delta.content },
      });
    }
  }

  function processLine(line) {
    if (!line.trim() || !line.startsWith("data: ")) return;
    const data = line.slice(6).trim();
    if (data === "[DONE]") return;
    try {
      const parsed = JSON.parse(data);
      const delta = parsed.choices?.[0]?.delta;
      if (delta) processDelta(delta);
    } catch {
      // ignore parse errors
    }
  }

  upstreamRes.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      processLine(line);
    }
  });

  upstreamRes.on("end", () => {
    // flush remaining buffer
    if (buffer.trim()) {
      for (const line of buffer.split("\n")) {
        processLine(line);
      }
    }

    // close last content block
    if (isToolUse || hasStartedTextBlock) {
      sendSSE("content_block_stop", {
        type: "content_block_stop",
        index: contentBlockIndex,
      });
    }

    sendSSE("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: isToolUse ? "tool_use" : "end_turn",
        stop_sequence: null,
      },
      usage: { input_tokens: 100, output_tokens: 150 },
    });

    sendSSE("message_stop", { type: "message_stop" });
    nodeRes.end();
  });

  upstreamRes.on("error", (err) => {
    console.error("Upstream stream error:", err.message);
    nodeRes.end();
  });
}

// ─── Upstream fetch helper (TLS bypass) ──────────────────────────────────────

function upstreamRequest(urlStr, method, headers, body, isStream) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers,
      rejectUnauthorized: false, // ← bypass internal CA
    };

    const transport = parsed.protocol === "https:" ? https : http;

    const req = transport.request(options, (res) => {
      if (isStream) {
        resolve(res); // return raw IncomingMessage for streaming
      } else {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          resolve({ status: res.statusCode, headers: res.headers, body: raw });
        });
      }
    });

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── Logging helpers ─────────────────────────────────────────────────────────

let requestCounter = 0;

function ts() {
  return new Date().toISOString();
}

function summarizeMessages(messages) {
  if (!Array.isArray(messages)) return "[]";
  return messages
    .map((m) => {
      const role = m.role || "?";
      if (typeof m.content === "string") {
        return `${role}(${m.content.length}ch)`;
      }
      if (Array.isArray(m.content)) {
        const types = m.content.map((c) => c.type || "?").join(",");
        return `${role}[${types}]`;
      }
      if (m.tool_calls) {
        const names = m.tool_calls
          .map((tc) => tc.function?.name || tc.name || "?")
          .join(",");
        return `${role}:tool_calls(${names})`;
      }
      if (m.role === "tool") {
        return `tool(${m.tool_call_id?.slice(0, 8) || "?"})`;
      }
      return `${role}(?)`;
    })
    .join(" → ");
}

// ─── HTTP server ─────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Health check
  if (url.pathname === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", upstream: UPSTREAM_BASE_URL }));
    return;
  }

  // Main endpoint: Anthropic Messages API
  if (url.pathname === "/v1/messages" && req.method === "POST") {
    const reqId = ++requestCounter;
    const t0 = Date.now();

    try {
      // Read body
      const bodyChunks = [];
      for await (const chunk of req) bodyChunks.push(chunk);
      const rawBody = Buffer.concat(bodyChunks).toString();
      const anthropicReq = JSON.parse(rawBody);

      const inModel = anthropicReq.model || "?";
      const msgCount = anthropicReq.messages?.length || 0;
      const toolCount = anthropicReq.tools?.length || 0;
      const isStream = !!anthropicReq.stream;

      console.log(
        `\n[${ts()}] ── #${reqId} INCOMING ──────────────────────────────`,
      );
      console.log(
        `  model: ${inModel} | messages: ${msgCount} | tools: ${toolCount} | stream: ${isStream}`,
      );

      // Convert Anthropic → OpenAI format
      const openaiReq = formatAnthropicToOpenAI(anthropicReq);

      const outModel = openaiReq.model;
      const outMsgCount = openaiReq.messages?.length || 0;
      const outToolCount = openaiReq.tools?.length || 0;

      console.log(
        `  → mapped model: ${outModel} | out messages: ${outMsgCount} | out tools: ${outToolCount}`,
      );
      console.log(
        `  → messages flow: ${summarizeMessages(openaiReq.messages)}`,
      );

      if (LOG_REQUESTS) {
        console.log(
          "\n  [DETAIL] Anthropic request body:\n",
          JSON.stringify(anthropicReq, null, 2).slice(0, 3000),
        );
        console.log(
          "\n  [DETAIL] OpenAI request body:\n",
          JSON.stringify(openaiReq, null, 2).slice(0, 3000),
        );
      }

      // Extract bearer token from incoming request
      const bearerToken =
        req.headers["x-api-key"] ||
        (req.headers["authorization"] || "").replace("Bearer ", "");

      const upstreamUrl = `${UPSTREAM_BASE_URL.replace(/\/+$/, "")}/v1/chat/completions`;
      console.log(
        `  → upstream: POST ${upstreamUrl} | auth: ${bearerToken ? bearerToken.slice(0, 8) + "..." : "NONE"}`,
      );

      const outHeaders = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`,
      };
      const outBody = JSON.stringify(openaiReq);

      if (isStream) {
        // ── Streaming path ──
        const upstreamRes = await upstreamRequest(
          upstreamUrl,
          "POST",
          outHeaders,
          outBody,
          true, // stream
        );

        const ttfb = Date.now() - t0;
        console.log(
          `  ← upstream status: ${upstreamRes.statusCode} | TTFB: ${ttfb}ms`,
        );

        if (upstreamRes.statusCode && upstreamRes.statusCode >= 400) {
          const errChunks = [];
          upstreamRes.on("data", (c) => errChunks.push(c));
          upstreamRes.on("end", () => {
            const errBody = Buffer.concat(errChunks).toString();
            console.error(
              `  ✗ UPSTREAM ERROR ${upstreamRes.statusCode}:\n  ${errBody.slice(0, 1000)}`,
            );
            res.writeHead(upstreamRes.statusCode, {
              "Content-Type": "text/plain",
            });
            res.end(errBody);
          });
          return;
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        console.log(`  ⇄ streaming started...`);

        // Track stream stats
        let streamChunks = 0;
        let streamBytes = 0;
        const origOnData = upstreamRes.listeners("data");

        upstreamRes.on("data", (chunk) => {
          streamChunks++;
          streamBytes += chunk.length;
        });

        const origEnd = upstreamRes.listeners("end");
        upstreamRes.on("end", () => {
          const elapsed = Date.now() - t0;
          console.log(
            `  ✓ #${reqId} stream complete | chunks: ${streamChunks} | bytes: ${streamBytes} | total: ${elapsed}ms`,
          );
        });

        streamOpenAIToAnthropic(upstreamRes, openaiReq.model, res);
      } else {
        // ── Non-streaming path ──
        const upstreamResult = await upstreamRequest(
          upstreamUrl,
          "POST",
          outHeaders,
          outBody,
          false,
        );

        const elapsed = Date.now() - t0;
        console.log(
          `  ← upstream status: ${upstreamResult.status} | time: ${elapsed}ms | body: ${upstreamResult.body.length}ch`,
        );

        if (upstreamResult.status >= 400) {
          console.error(
            `  ✗ UPSTREAM ERROR ${upstreamResult.status}:\n  ${upstreamResult.body.slice(0, 1000)}`,
          );
          res.writeHead(upstreamResult.status, {
            "Content-Type": "text/plain",
          });
          res.end(upstreamResult.body);
          return;
        }

        const openaiData = JSON.parse(upstreamResult.body);
        const anthropicResponse = formatOpenAIToAnthropic(
          openaiData,
          openaiReq.model,
        );

        const respContentTypes =
          anthropicResponse.content?.map((c) => c.type).join(",") || "empty";
        const respTextLen =
          anthropicResponse.content
            ?.filter((c) => c.type === "text")
            .reduce((sum, c) => sum + (c.text?.length || 0), 0) || 0;

        console.log(
          `  ✓ #${reqId} done | stop: ${anthropicResponse.stop_reason} | content: [${respContentTypes}] | text: ${respTextLen}ch | total: ${elapsed}ms`,
        );

        if (LOG_REQUESTS) {
          console.log(
            "\n  [DETAIL] OpenAI response:\n",
            JSON.stringify(openaiData, null, 2).slice(0, 3000),
          );
          console.log(
            "\n  [DETAIL] Anthropic response:\n",
            JSON.stringify(anthropicResponse, null, 2).slice(0, 3000),
          );
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(anthropicResponse));
      }
    } catch (err) {
      const elapsed = Date.now() - t0;
      console.error(`  ✗ #${reqId} EXCEPTION after ${elapsed}ms:`, err.message);
      console.error(
        `    stack: ${err.stack?.split("\n").slice(0, 3).join("\n    ")}`,
      );
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 404 for everything else
  console.log(`[${ts()}] 404 ${req.method} ${req.url}`);
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

server.listen(PORT, () => {
  console.log(`\n🚀 qwen3.5-scw-router listening on http://localhost:${PORT}`);
  console.log(`   Upstream: ${UPSTREAM_BASE_URL}`);
  console.log(`   Logging:  ${LOG_REQUESTS ? "enabled" : "disabled"}`);
  console.log(`\n   Configure Claude Code with:`);
  console.log(`   ANTHROPIC_BASE_URL=http://localhost:${PORT}`);
  console.log();
});
