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
        endpoints: ["/generate", "/health"]
      }, 200, env);
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return jsonResponse({
        ok: true,
        message: "Worker is running.",
        githubRawBase: env.GITHUB_RAW_BASE || null,
        geminiModel: env.GEMINI_MODEL || "gemini-1.5-flash"
      }, 200, env);
    }

    if (url.pathname === "/generate" && request.method === "POST") {
      try {
        return await handleGenerate(request, env, ctx);
      } catch (error) {
        console.error("Worker error:", error);
        return jsonResponse({
          error: error.message || "Internal server error"
        }, 500, env);
      }
    }

    return jsonResponse({ error: "Not found" }, 404, env);
  }
};

async function handleGenerate(request, env, ctx) {
  let body;

  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400, env);
  }

  const userPrompt = String(body.prompt || "").trim();

  if (!userPrompt) {
    return jsonResponse({ error: "Prompt is required." }, 400, env);
  }

  if (!env.GEMINI_API_KEY) {
    return jsonResponse({ error: "GEMINI_API_KEY secret is missing." }, 500, env);
  }

  const repoBase = String(env.GITHUB_RAW_BASE || "").replace(/\/+$/, "");

  if (!repoBase) {
    return jsonResponse({ error: "GITHUB_RAW_BASE is missing." }, 500, env);
  }

  const [instructions, templatesRaw, database, mapping] = await Promise.all([
    fetchTextCached(`${repoBase}/instructions.txt`, env),
    fetchJsonCached(`${repoBase}/templates.json`, env),
    fetchTextCached(`${repoBase}/database.txt`, env),
    fetchTextCached(`${repoBase}/mapping.txt`, env)
  ]);

  const templates = normalizeTemplates(templatesRaw);

  if (!Array.isArray(templates) || !templates.length) {
    return jsonResponse({
      error: "No templates found in templates.json. Make sure templates.json contains an array of templates, an object with a templates array, or template objects."
    }, 500, env);
  }

  const language = detectLanguage(userPrompt);
  const templateType = detectTemplateType(userPrompt, mapping);

  let selectedTemplate = findBestTemplate(templates, templateType, language);

  if (!selectedTemplate) {
    return jsonResponse({
      error: "Could not select a template.",
      detectedLanguage: language,
      detectedTemplateType: templateType,
      templatesFound: templates.length
    }, 500, env);
  }

  selectedTemplate = normalizeSingleTemplate(selectedTemplate);

  if (!selectedTemplate.html) {
    return jsonResponse({
      error: "Selected template does not contain an html or template field.",
      selectedTemplate
    }, 500, env);
  }

  const compactPrompt = buildAiPrompt({
    userPrompt,
    language,
    templateType,
    template: selectedTemplate,
    instructions,
    database
  });

  const html = await callGemini(compactPrompt, env);

  return jsonResponse({
    ok: true,
    language,
    templateType,
    templateId: selectedTemplate.id || "",
    templateName: selectedTemplate.name || "",
    html
  }, 200, env);
}

function buildAiPrompt({ userPrompt, language, templateType, template, instructions, database }) {
  const compactInstructions = limitText(instructions, 1400);
  const compactDatabase = limitText(database, 1400);
  const compactTemplate = limitText(template.html, 9000);

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
- Keep the original HTML/CSS structure as much as possible.
- For Sindhi, use RTL-compatible Sindhi text.
- For English, use formal school communication style.

DETECTED TEMPLATE TYPE:
${templateType}

INSTRUCTIONS:
${compactInstructions}

SCHOOL DATABASE:
${compactDatabase}

USER REQUEST:
${userPrompt}

SELECTED TEMPLATE NAME:
${template.name || template.id || "Unnamed Template"}

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
      maxOutputTokens: 3000
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
    console.error("Gemini API error:", JSON.stringify(data, null, 2));
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
  return String(text || "")
    .replace(/^```html\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

/**
 * Supports these templates.json formats:
 *
 * Format 1:
 * [
 *   { "id": "...", "type": "...", "language": "...", "html": "..." }
 * ]
 *
 * Format 2:
 * {
 *   "templates": [
 *     { "id": "...", "type": "...", "language": "...", "html": "..." }
 *   ]
 * }
 *
 * Format 3:
 * {
 *   "press_release_en": { "type": "...", "language": "...", "template": "..." },
 *   "press_release_sd": { "type": "...", "language": "...", "template": "..." }
 * }
 *
 * Format 4:
 * {
 *   "English": [
 *     { "name": "Press Release", "html": "..." }
 *   ],
 *   "Sindhi": [
 *     { "name": "پريس رليز", "html": "..." }
 *   ]
 * }
 */
function normalizeTemplates(input) {
  const results = [];

  function addTemplate(item, key = "") {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return;
    }

    const hasHtml = typeof item.html === "string" && item.html.trim();
    const hasTemplate = typeof item.template === "string" && item.template.trim();

    if (!hasHtml && !hasTemplate) {
      return;
    }

    const normalized = normalizeSingleTemplate({
      ...item,
      id: item.id || key || "",
      html: item.html || item.template || ""
    });

    results.push(normalized);
  }

  function walk(value, key = "", depth = 0) {
    if (depth > 4 || !value) {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        addTemplate(item, key);
      }
      return;
    }

    if (typeof value !== "object") {
      return;
    }

    if (value.html || value.template) {
      addTemplate(value, key);
      return;
    }

    if (Array.isArray(value.templates)) {
      for (const item of value.templates) {
        addTemplate(item);
      }
      return;
    }

    if (value.templates && typeof value.templates === "object") {
      walk(value.templates, "templates", depth + 1);
      return;
    }

    for (const [childKey, childValue] of Object.entries(value)) {
      if (Array.isArray(childValue)) {
        for (const item of childValue) {
          if (item && typeof item === "object") {
            const extra = {};

            if (!item.language && isLanguageName(childKey)) {
              extra.language = normalizeLanguageName(childKey);
            }

            addTemplate({ ...item, ...extra }, item.id || childKey);
          }
        }
      } else if (childValue && typeof childValue === "object") {
        if (childValue.html || childValue.template) {
          addTemplate(childValue, childKey);
        } else {
          walk(childValue, childKey, depth + 1);
        }
      }
    }
  }

  walk(input);

  return results;
}

function normalizeSingleTemplate(template) {
  const id = String(template.id || "").trim();
  const name = String(template.name || "").trim();

  const html = String(template.html || template.template || "").trim();

  const type = String(
    template.type ||
    inferTemplateType(`${id} ${name}`) ||
    ""
  ).trim();

  const language = String(
    template.language ||
    inferLanguageFromTemplate(`${id} ${name} ${html}`) ||
    ""
  ).trim();

  return {
    ...template,
    id,
    name,
    type,
    language,
    html
  };
}

function findBestTemplate(templates, templateType, language) {
  const normalizedTemplates = templates.map(normalizeSingleTemplate);

  const wantedType = normalize(templateType);
  const wantedLanguage = normalize(language);

  // 1. Exact type and exact language
  let found = normalizedTemplates.find((t) => {
    return normalize(t.type) === wantedType &&
      normalize(t.language) === wantedLanguage;
  });

  if (found) return found;

  // 2. Type found in id/name and exact language
  found = normalizedTemplates.find((t) => {
    const haystack = normalize(`${t.id} ${t.name} ${t.type}`);
    return haystack.includes(wantedType) &&
      normalize(t.language) === wantedLanguage;
  });

  if (found) return found;

  // 3. Exact type only
  found = normalizedTemplates.find((t) => {
    return normalize(t.type) === wantedType;
  });

  if (found) return found;

  // 4. Language only
  found = normalizedTemplates.find((t) => {
    return normalize(t.language) === wantedLanguage;
  });

  if (found) return found;

  // 5. First available template
  return normalizedTemplates[0] || null;
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
    const equalsIndex = line.indexOf("=");

    if (equalsIndex === -1) {
      continue;
    }

    const type = line.slice(0, equalsIndex).trim();
    const aliasesRaw = line.slice(equalsIndex + 1).trim();

    if (!type || !aliasesRaw) {
      continue;
    }

    const aliases = aliasesRaw
      .split(",")
      .map((a) => normalize(a))
      .filter(Boolean);

    for (const alias of aliases) {
      if (text.includes(alias)) {
        return type;
      }
    }
  }

  return inferTemplateType(prompt) || "press_release";
}

function inferTemplateType(text) {
  const value = normalize(text).replace(/[-\s]+/g, "_");

  const knownTypes = [
    "press_release",
    "staff_congratulations",
    "monthly_test_toppers",
    "annual_exam_toppers",
    "official_visit",
    "admission_open",
    "sports_day",
    "parent_meeting"
  ];

  for (const type of knownTypes) {
    if (value.includes(type)) {
      return type;
    }
  }

  const simple = normalize(text);

  if (simple.includes("press release") || simple.includes("پريس")) {
    return "press_release";
  }

  if (simple.includes("staff") || simple.includes("congratulations") || simple.includes("مبارڪ")) {
    return "staff_congratulations";
  }

  if (simple.includes("monthly") || simple.includes("ماهوار")) {
    return "monthly_test_toppers";
  }

  if (simple.includes("annual") || simple.includes("سالياني")) {
    return "annual_exam_toppers";
  }

  if (simple.includes("visit") || simple.includes("دورو")) {
    return "official_visit";
  }

  if (simple.includes("admission") || simple.includes("داخلا")) {
    return "admission_open";
  }

  if (simple.includes("sports") || simple.includes("راند")) {
    return "sports_day";
  }

  if (simple.includes("parent") || simple.includes("والدين")) {
    return "parent_meeting";
  }

  return "";
}

function inferLanguageFromTemplate(text) {
  const value = String(text || "");

  if (/\b(sd|sindhi)\b/i.test(value) || /_sd\b/i.test(value) || /[\u0600-\u06FF]/.test(value)) {
    return "Sindhi";
  }

  if (/\b(en|english)\b/i.test(value) || /_en\b/i.test(value)) {
    return "English";
  }

  return "";
}

function isLanguageName(value) {
  const v = normalize(value);
  return v === "english" || v === "en" || v === "sindhi" || v === "sd";
}

function normalizeLanguageName(value) {
  const v = normalize(value);

  if (v === "sindhi" || v === "sd") {
    return "Sindhi";
  }

  return "English";
}

async function fetchTextCached(url, env) {
  const response = await fetchCached(url, env);

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}. Status: ${response.status}`);
  }

  return await response.text();
}

async function fetchJsonCached(url, env) {
  const text = await fetchTextCached(url, env);

  try {
    return JSON.parse(text);
  } catch (error) {
    console.error("Invalid JSON:", text.slice(0, 500));
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
    .replace(/[_-]+/g, " ")
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
