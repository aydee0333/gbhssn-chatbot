const API_URL = "https://gbhssn.aydee-0333.workers.dev";

const promptEl = document.getElementById("prompt");
const generateBtn = document.getElementById("generateBtn");
const clearBtn = document.getElementById("clearBtn");
const statusEl = document.getElementById("status");
const htmlOutput = document.getElementById("htmlOutput");
const preview = document.getElementById("preview");
const copyBtn = document.getElementById("copyBtn");
const downloadBtn = document.getElementById("downloadBtn");

generateBtn.addEventListener("click", generateHtml);
clearBtn.addEventListener("click", clearAll);
copyBtn.addEventListener("click", copyHtml);
downloadBtn.addEventListener("click", downloadHtml);

document.querySelectorAll(".example").forEach((btn) => {
  btn.addEventListener("click", () => {
    promptEl.value = btn.textContent;
  });
});

async function generateHtml() {
  const prompt = promptEl.value.trim();

  if (!prompt) {
    setStatus("Please enter a prompt.", true);
    return;
  }

  setLoading(true);
  setStatus("Generating...");

  try {
    const response = await fetch(`${API_URL}/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ prompt })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Request failed.");
    }

    htmlOutput.value = data.html || "";
    preview.srcdoc = data.html || "";

    setStatus(`Done. Template: ${data.templateName || "Unknown"} | Language: ${data.language || "Unknown"}`);
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Something went wrong.", true);
  } finally {
    setLoading(false);
  }
}

function clearAll() {
  promptEl.value = "";
  htmlOutput.value = "";
  preview.srcdoc = "";
  setStatus("");
}

async function copyHtml() {
  const html = htmlOutput.value;

  if (!html) {
    setStatus("Nothing to copy.", true);
    return;
  }

  await navigator.clipboard.writeText(html);
  setStatus("HTML copied.");
}

function downloadHtml() {
  const html = htmlOutput.value;

  if (!html) {
    setStatus("Nothing to download.", true);
    return;
  }

  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = "school-template.html";
  a.click();

  URL.revokeObjectURL(url);
  setStatus("Downloaded.");
}

function setLoading(isLoading) {
  generateBtn.disabled = isLoading;
  generateBtn.textContent = isLoading ? "Generating..." : "Generate HTML";
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#dc2626" : "#334155";
}
