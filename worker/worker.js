export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return handleOptions(env);
    }

    if (url.pathname === "/" && request.method === "GET") {
      return jsonResponse({
        ok: true,
        service: "School AI Template Worker",
        endpoints: ["/generate"]
      }, 200, env);
    }

    if (url.pathname === "/generate" && request.method === "POST") {
      try {
        return await handleGenerate(request, env, ctx);
      } catch (error) {
        console.error(error);
        return jsonResponse({
          error: error.message || "Internal server error"
        }, 500, env);
      }
    }

    return jsonResponse({ error: "Not found" }, 404, env);
  }
};

async function handleGenerate(request, env, ctx) {
  const body = await request.json();
  const userPrompt = String(body.prompt || "").trim();

  if (!userPrompt) {
    return jsonResponse({ error: "Prompt is required." }, 400, env);
  }

  if (!env.GEMINI_API_KEY) {
    return jsonResponse({ error: "GEMINI_API_KEY secret is missing." }, 500, env);
  }

  const repoBase = env.GITHUB_RAW_BASE;

  if (!repoBase) {
    return jsonResponse({ error: "GITHUB_RAW_BASE is missing." }, 500, env);
  }

  const [instructions, templates, database, mapping] = await Promise.all([
    fetchTextCached(`${repoBase}/instructions.txt`, env),
    fetchJsonCached(`${repoBase}/templates.json`, env),
    fetchTextCached(`${repoBase}/database.txt`, env),
    fetchTextCached(`${repoBase}/mapping.txt`, env)
  ]);

  const language = detectLanguage(userPrompt);
  const templateType = detectTemplateType(userPrompt, mapping);

  let selectedTemplate = templates.find((t) => {
    return normalize(t.type) === normalize(templateType)
      && normalize(t.language) === normalize(language);
  });

  if (!selectedTemplate) {
    selectedTemplate = templates.find((t) => normalize(t.language) === normalize(language));
  }

  if (!selectedTemplate) {
    selectedTemplate = templates[0];
  }

  const compactPrompt = buildAiPrompt({
    userPrompt,
    language,
    template: selectedTemplate,
    instructions,
    database
  });

  const html = await callGemini(compactPrompt, env);

  return jsonResponse({
    ok: true,
    language,
    templateType,
    templateId: selectedTemplate.id,
    templateName: selectedTemplate.name,
    html
  }, 200, env);
}

function buildAiPrompt({ userPrompt, language, template, instructions, database }) {
  const compactInstructions = limitText(instructions, 1400);
  const compactDatabase = limitText(database, 1400);
  const compactTemplate = limitText(template.html, 8000);

  return `
You are a school HTML content generator.

OUTPUT RULES:
- Output only the final HTML.
- Do not use markdown.
- Do not wrap output in code fences.
- Use ${language} language.
- Follow the given HTML template.
- Replace template placeholders with suitable content.
- Do not invent specific names, marks, dates, classes, or positions unless provided by user.
- If details are missing, use clear placeholders like [Student Name], [Class], [Date].
- Keep content respectful and suitable for school communication.

INSTRUCTIONS:
${compactInstructions}

SCHOOL DATABASE:
${compactDatabase}

USER REQUEST:
${userPrompt}

SELECTED TEMPLATE NAME:
${template.name}

HTML TEMPLATE:
${compactTemplate}
`.trim();
}

async function callGemini(prompt, env) {
  const model = env.GEMINI_MODEL || "gemini-1.5-flash";

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

  const payload = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: prompt
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.35,
      topP: 0.9,
      maxOutputTokens: 2500
    }
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("Gemini error:", JSON.stringify(data));
    throw new Error(data.error?.message || "Gemini API request failed.");
  }

  let text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";

  text = cleanHtmlOutput(text);

  if (!text) {
    throw new Error("AI returned an empty response.");
  }

  return text;
}

function cleanHtmlOutput(text) {
  return String(text)
    .replace(/^```html\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function detectLanguage(prompt) {
  const text = String(prompt || "").toLowerCase();

  const hasArabicScript = /[\u0600-\u06FF]/.test(text);

  if (hasArabicScript) {
    return "Sindhi";
  }

  if (
    text.includes("sindhi") ||
    text.includes("sd") ||
    text.includes("سنڌي") ||
    text.includes("sindhi language")
  ) {
    return "Sindhi";
  }

  return "English";
}

function detectTemplateType(prompt, mappingText) {
  const text = normalize(prompt);
  const lines = String(mappingText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  for (const line of lines) {
    const [type, aliasesRaw] = line.split("=");

    if (!type || !aliasesRaw) continue;

    const aliases = aliasesRaw
      .split(",")
      .map((a) => normalize(a))
      .filter(Boolean);

    for (const alias of aliases) {
      if (text.includes(alias)) {
        return type.trim();
      }
    }
  }

  return "press_release";
}

async function fetchTextCached(url, env) {
  const response = await fetchCached(url, env);

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}`);
  }

  return await response.text();
}

async function fetchJsonCached(url, env) {
  const text = await fetchTextCached(url, env);

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${url}`);
  }
}

async function fetchCached(url, env) {
  const cache = caches.default;
  const cacheKey = new Request(url, { method: "GET" });

  const cached = await cache.match(cacheKey);

  if (cached) {
    return cached;
  }

  const response = await fetch(url, {
    headers: {
      "User-Agent": "school-ai-template-worker"
    }
  });

  const ttl = Number(env.CACHE_TTL_SECONDS || "300");

  if (response.ok) {
    const cachedResponse = new Response(response.body, response);
    cachedResponse.headers.set("Cache-Control", `public, max-age=${ttl}`);
    await cache.put(cacheKey, cachedResponse.clone());
    return cachedResponse;
  }

  return response;
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function limitText(text, maxChars) {
  text = String(text || "");

  if (text.length <= maxChars) {
    return text;
  }

  return text.slice(0, maxChars) + "\n...[trimmed]";
}

function handleOptions(env) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(env)
  });
}

function jsonResponse(data, status = 200, env) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(env)
    }
  });
}

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
