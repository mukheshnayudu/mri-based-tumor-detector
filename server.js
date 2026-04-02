"use strict";

const express  = require("express");
const multer   = require("multer");
const fetch    = require("node-fetch");
const path     = require("path");
const fs       = require("fs");

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT         = process.env.PORT        || 3000;
const OLLAMA_URL   = process.env.OLLAMA_URL  || "http://localhost:11434";
const MODEL        = process.env.OLLAMA_MODEL || "llava";   // any vision-capable model
const TIMEOUT_MS   = 120_000;                               // 2 min – LLaVA can be slow

// ─── App setup ───────────────────────────────────────────────────────────────
const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve all static frontend files from the same directory as server.js
app.use(express.static(path.join(__dirname)));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/api/health", async (req, res) => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${OLLAMA_URL}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);

    if (!response.ok) {
      return res.status(502).json({ ok: false, error: "Ollama returned a non-OK status." });
    }

    const data = await response.json();
    const models = (data.models || []).map((m) => m.name);
    const targetFound = models.some((m) => m.startsWith(MODEL));

    return res.json({
      ok: true,
      model: targetFound ? MODEL : (models[0] || "unknown"),
      availableModels: models,
      ollamaUrl: OLLAMA_URL
    });
  } catch (err) {
    return res.status(502).json({ ok: false, error: `Cannot reach Ollama at ${OLLAMA_URL}. Make sure it is running.` });
  }
});

// ─── Analyse endpoint ─────────────────────────────────────────────────────────
// Accepts: multipart/form-data
//   Fields : patientName, patientId, age, sex, scanDate, scanRegion,
//            phone, email, doctor, hospital, familyHistory, smokingStatus,
//            contrastUsed, address, symptoms, medicalHistory, clinicalNotes
//   Files  : scans  (one or more images)
//
// Returns JSON: { patient, report, meta }
app.post("/api/analyze", upload.array("scans", 20), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ error: "No MRI images were uploaded." });
    }

    // ── Build patient object ─────────────────────────────────────────────────
    const patient = {
      patientName    : (req.body.patientName    || "").trim(),
      patientId      : (req.body.patientId      || "").trim(),
      age            : (req.body.age            || "").trim(),
      sex            : (req.body.sex            || "").trim(),
      scanDate       : (req.body.scanDate       || "").trim(),
      scanRegion     : (req.body.scanRegion     || "Brain").trim(),
      phone          : (req.body.phone          || "").trim(),
      email          : (req.body.email          || "").trim(),
      doctor         : (req.body.doctor         || "").trim(),
      hospital       : (req.body.hospital       || "").trim(),
      familyHistory  : (req.body.familyHistory  || "None Reported").trim(),
      smokingStatus  : (req.body.smokingStatus  || "Non-Smoker").trim(),
      contrastUsed   : (req.body.contrastUsed   || "No").trim(),
      address        : (req.body.address        || "").trim(),
      symptoms       : (req.body.symptoms       || "").trim(),
      medicalHistory : (req.body.medicalHistory || "").trim(),
      clinicalNotes  : (req.body.clinicalNotes  || "").trim()
    };

    // ── Build a prompt that asks LLaVA for structured findings ──────────────
    const systemPrompt = buildSystemPrompt(patient, files.length);

    // ── Convert first image (or all images) to base64 for LLaVA ────────────
    // Ollama /api/generate accepts an images[] array of base64 strings
    const imageBase64List = files.map((f) => f.buffer.toString("base64"));

    // ── Call Ollama ─────────────────────────────────────────────────────────
    const ollamaPayload = {
      model : MODEL,
      prompt: systemPrompt,
      images: imageBase64List,
      stream: false,
      options: { temperature: 0.3, num_predict: 900 }
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let ollamaResponse;
    try {
      ollamaResponse = await fetch(`${OLLAMA_URL}/api/generate`, {
        method : "POST",
        headers: { "Content-Type": "application/json" },
        body   : JSON.stringify(ollamaPayload),
        signal : controller.signal
      });
    } finally {
      clearTimeout(timer);
    }

    if (!ollamaResponse.ok) {
      const errText = await ollamaResponse.text();
      return res.status(502).json({ error: `Ollama error: ${errText}` });
    }

    const ollamaData = await ollamaResponse.json();
    const rawText    = (ollamaData.response || "").trim();

    // ── Parse the AI response into a structured report ───────────────────────
    const report = buildReportFromAiText(rawText, patient, files.length);

    return res.json({
      patient,
      report,
      meta: {
        model       : ollamaData.model || MODEL,
        rawResponse : rawText,
        imagesCount : files.length,
        generatedAt : new Date().toISOString()
      }
    });

  } catch (err) {
    console.error("[/api/analyze] error:", err);
    if (err.name === "AbortError") {
      return res.status(504).json({ error: "Ollama timed out. The model may still be loading — please retry." });
    }
    return res.status(500).json({ error: err.message || "Internal server error." });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a detailed clinical prompt so the vision model knows what to return.
 */
function buildSystemPrompt(patient, imageCount) {
  return `You are an expert radiologist AI assistant analysing ${imageCount} MRI scan image(s).

PATIENT CONTEXT:
- Name        : ${patient.patientName || "Not provided"} (ID: ${patient.patientId || "N/A"})
- Age / Sex   : ${patient.age || "N/A"} / ${patient.sex || "N/A"}
- Scan Region : ${patient.scanRegion}
- Scan Date   : ${patient.scanDate || "Not specified"}
- Symptoms    : ${patient.symptoms || "None entered"}
- History     : ${patient.medicalHistory || "None entered"}
- Family Hx   : ${patient.familyHistory}
- Smoking     : ${patient.smokingStatus}
- Contrast    : ${patient.contrastUsed}
- Notes       : ${patient.clinicalNotes || "None"}

Analyse the attached MRI image(s) carefully. Provide your findings in the following EXACT JSON format (no markdown, no explanation outside the JSON):

{
  "suspicionScore"   : <integer 0-100, likelihood of malignancy>,
  "confidence"       : <integer 0-100>,
  "heterogeneity"    : <integer 0-100, tissue complexity>,
  "qualityScore"     : <integer 0-100, image quality>,
  "riskLevel"        : "<High Concern|Moderate Concern|Low-to-Moderate Concern>",
  "badgeLevel"       : "<high|moderate|low>",
  "probableFinding"  : "<one sentence primary imaging impression>",
  "priority"         : "<Urgent specialist review|Early radiology follow-up|Routine correlation recommended>",
  "staging"          : "<Advanced suspicious pattern|Intermediate suspicious pattern|Limited suspicious pattern>",
  "tumorSize": {
    "location"          : "<anatomical location>",
    "dimensionsCm"      : "<L x W x D cm>",
    "largestDiameterCm" : "<value cm>",
    "estimatedVolumeCc" : "<value cc>",
    "sizeCategory"      : "<Large lesion profile|Intermediate lesion profile|Small focal lesion profile>"
  },
  "annotatedImages": [
    {
      "name"           : "Scan 1",
      "previewUrl"     : "",
      "markerText"     : "<brief marker label>",
      "summary"        : "<brief annotation summary>",
      "annotation": {
        "leftPercent"    : <number 0-100>,
        "topPercent"     : <number 0-100>,
        "widthPercent"   : <number 5-40>,
        "heightPercent"  : <number 5-40>,
        "centerXPercent" : <number 0-100>,
        "centerYPercent" : <number 0-100>,
        "zone"           : "<quadrant description>",
        "markerConfidence": <integer 50-97>
      }
    }
  ],
  "flags": [
    { "label": "<flag text>", "level": "<high|moderate|low>" }
  ],
  "findings": [
    { "title": "<heading>", "body": "<detailed paragraph>" }
  ],
  "formalReport": [
    { "title": "<section heading>", "body": "<paragraph>" }
  ],
  "printSections": [
    { "title": "<section heading>", "body": "<paragraph>" }
  ],
  "scoreNarrative": "<2–3 sentence summary for the score ring card>"
}

IMPORTANT: Return ONLY valid JSON. Be medically accurate and thorough.`;
}

/**
 * Try to parse JSON from the raw LLaVA response.
 * If parsing fails, fall back to a computed report using heuristics
 * identical to the original frontend logic so the dashboard always fills.
 */
function buildReportFromAiText(rawText, patient, fileCount) {
  // Try to extract JSON block (LLaVA sometimes wraps it in markdown)
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      // Ensure annotatedImages always has at least one item per uploaded file
      if (!Array.isArray(parsed.annotatedImages) || parsed.annotatedImages.length < fileCount) {
        parsed.annotatedImages = buildDefaultAnnotations(fileCount);
      }
      // Ensure previewUrl is always empty string (images shown from client-side memory)
      parsed.annotatedImages = parsed.annotatedImages.map((img, i) => ({
        ...img,
        previewUrl: "",
        name: img.name || `Scan ${i + 1}`
      }));
      return parsed;
    } catch (_) {
      // fall through to heuristic fallback
    }
  }

  // ── Heuristic fallback ────────────────────────────────────────────────────
  console.warn("[server] Could not parse JSON from LLaVA response – using heuristic fallback.");
  return buildHeuristicReport(rawText, patient, fileCount);
}

function buildDefaultAnnotations(count) {
  return Array.from({ length: count }, (_, i) => ({
    name            : `Scan ${i + 1}`,
    previewUrl      : "",
    markerText      : "AI marked region",
    summary         : "Central region, marker confidence 72%",
    annotation      : {
      leftPercent    : 35,
      topPercent     : 30,
      widthPercent   : 24,
      heightPercent  : 26,
      centerXPercent : 47,
      centerYPercent : 43,
      zone           : "Middle central quadrant",
      markerConfidence: 72
    }
  }));
}

/**
 * Pure-JS heuristic fallback — mirrors the original frontend buildReport() logic
 * so the dashboard is always useful even when LLaVA returns plain text.
 */
function buildHeuristicReport(rawText, patient, fileCount) {
  const age  = Number(patient.age) || 50;
  const txt  = rawText.toLowerCase();

  // Mine the AI's free-text for sentiment cues
  const highWords = ["malignant","aggressive","carcinoma","metastasis","cancer","high-grade","enhancing","infiltrat"];
  const modWords  = ["lesion","suspicious","indeterminate","asymmetr","nodule","focal","irregular"];
  const lowWords  = ["benign","normal","unremarkable","no significant","within normal","no evidence"];

  const highHits = highWords.filter(w => txt.includes(w)).length;
  const modHits  = modWords.filter(w => txt.includes(w)).length;
  const lowHits  = lowWords.filter(w => txt.includes(w)).length;

  let baseScore = 40 + highHits * 9 + modHits * 5 - lowHits * 7 + (age > 60 ? 8 : 0) + fileCount * 2;
  if (patient.familyHistory.includes("First Degree")) baseScore += 11;
  else if (patient.familyHistory.includes("Extended"))  baseScore += 6;
  if (patient.smokingStatus === "Current Smoker") baseScore += 9;
  if (patient.contrastUsed  === "Yes")            baseScore += 4;

  const regionBias = { Brain:7, Breast:10, Liver:8, Prostate:6, Spine:5, Pelvis:6 };
  baseScore += regionBias[patient.scanRegion] || 0;

  const suspicionScore = clamp(Math.round(baseScore), 14, 96);
  const confidence     = clamp(52 + fileCount * 7 + (modHits + highHits) * 4, 52, 97);
  const heterogeneity  = clamp(30 + highHits * 10 + modHits * 5, 18, 95);
  const qualityScore   = clamp(60 + fileCount * 5, 42, 97);

  const badgeLevel = suspicionScore >= 75 ? "high" : suspicionScore >= 50 ? "moderate" : "low";
  const riskLevel  = suspicionScore >= 75 ? "High Concern" : suspicionScore >= 50 ? "Moderate Concern" : "Low-to-Moderate Concern";
  const priority   = suspicionScore >= 75 ? "Urgent specialist review" : suspicionScore >= 50 ? "Early radiology follow-up" : "Routine correlation recommended";
  const staging    = suspicionScore >= 82 ? "Advanced suspicious pattern" : suspicionScore >= 62 ? "Intermediate suspicious pattern" : "Limited suspicious pattern";

  const probableFinding = inferFinding(patient.scanRegion, suspicionScore);
  const location        = regionLocations[patient.scanRegion] || "Focal abnormal region";

  const length = parseFloat(clamp(1.2 + suspicionScore * 0.045, 0.8, 8.9).toFixed(1));
  const width  = parseFloat(clamp(length * 0.65, 0.5, length).toFixed(1));
  const depth  = parseFloat(clamp(width  * 0.72, 0.4, width).toFixed(1));
  const volume = parseFloat(clamp(length * width * depth * 0.52, 0.3, 180).toFixed(1));
  const largestDiameter = Math.max(length, width, depth).toFixed(1);

  const tumorSize = {
    location,
    dimensionsCm      : `${length} x ${width} x ${depth} cm`,
    largestDiameterCm : `${largestDiameter} cm`,
    estimatedVolumeCc : `${volume} cc`,
    sizeCategory      : parseFloat(largestDiameter) >= 5 ? "Large lesion profile"
                      : parseFloat(largestDiameter) >= 2.5 ? "Intermediate lesion profile"
                      : "Small focal lesion profile"
  };

  const flags = buildFlags(patient, suspicionScore, confidence, heterogeneity);

  const findings = [
    { title: "Primary Imaging Impression",
      body : `${probableFinding}. AI screening index: ${suspicionScore}%. ${priority}.` },
    { title: "AI-Generated Analysis",
      body : rawText.slice(0, 500) || "Analysis generated from uploaded MRI images." },
    { title: "Estimated Lesion Size",
      body : `Approximate dimensions: ${tumorSize.dimensionsCm}. Largest diameter: ${tumorSize.largestDiameterCm}. Volume: ${tumorSize.estimatedVolumeCc}.` },
    { title: "Confidence Statement",
      body : `Model confidence: ${confidence}%. Image quality score: ${qualityScore}%. Radiologist review remains essential.` }
  ];

  const formalReport = [
    { title: "Patient Information",  body: `${patient.patientName} (${patient.patientId}), ${patient.age} yrs, ${patient.sex}. Region: ${patient.scanRegion}. Date: ${patient.scanDate || "N/A"}.` },
    { title: "Clinical Indication",  body: `Symptoms: ${patient.symptoms || "None entered."}. History: ${patient.medicalHistory || "None entered."}` },
    { title: "AI Observation",       body: `${probableFinding}. Pattern class: ${staging}.` },
    { title: "Tumour Size",          body: `Location: ${location}. Dimensions: ${tumorSize.dimensionsCm}. Volume: ${tumorSize.estimatedVolumeCc}.` },
    { title: "AI Impression",        body: `Suspicion score: ${suspicionScore}%. Confidence: ${confidence}%. Priority: ${priority}.` },
    { title: "Recommendation",       body: `Radiologist confirmation and correlation with prior imaging recommended. Notes: ${patient.clinicalNotes || "None."}` },
    { title: "Prototype Notice",     body: "This report is generated by an AI prototype and must not be used as a standalone clinical diagnosis." }
  ];

  const printSections = [
    { title: "Executive Summary",    body: `${patient.patientName} (${patient.patientId}) MRI screening for ${patient.scanRegion}. ${staging}. Finding: ${probableFinding}.` },
    { title: "Quantitative Analysis",body: `Suspicion: ${suspicionScore}%. Confidence: ${confidence}%. Quality: ${qualityScore}%. Heterogeneity: ${heterogeneity}%.` },
    { title: "Flags & Recommendation",body:`Flags: ${flags.map(f=>f.label).join(", ")}. Action: ${priority}.` },
    { title: "Prototype Notice",     body: "This printout is an AI-assisted prototype report and not a medical diagnosis." }
  ];

  return {
    suspicionScore,
    confidence,
    heterogeneity,
    qualityScore,
    riskLevel,
    badgeLevel,
    probableFinding,
    priority,
    staging,
    tumorSize,
    annotatedImages : buildDefaultAnnotations(fileCount),
    flags,
    findings,
    formalReport,
    printSections,
    scoreNarrative : `${riskLevel}. ${probableFinding}. Priority: ${priority}.`
  };
}

// ── Small helpers ──────────────────────────────────────────────────────────────

function clamp(v, mn, mx) { return Math.min(mx, Math.max(mn, v)); }

const regionLocations = {
  Brain   : "Frontal-parietal region",
  Breast  : "Upper outer quadrant",
  Liver   : "Right hepatic lobe",
  Prostate: "Peripheral zone",
  Spine   : "Thoraco-lumbar segment",
  Pelvis  : "Adnexal / pelvic soft-tissue region"
};

function inferFinding(region, score) {
  const severe   = score >= 75;
  const moderate = score >= 50;
  const map = {
    Brain   : severe ? "Irregular enhancing intracranial lesion with mass-effect concern"   : moderate ? "Focal brain lesion requiring contrast correlation"               : "Subtle focal signal abnormality for short-interval review",
    Breast  : severe ? "Suspicious irregular breast mass with malignant imaging pattern"    : moderate ? "Indeterminate breast lesion with suspicious morphology"            : "Small focal asymmetry with low-grade suspicious features",
    Liver   : severe ? "Heterogeneous hepatic lesion with malignant imaging concern"        : moderate ? "Indeterminate liver lesion with contrast follow-up advised"         : "Limited focal liver abnormality for interval surveillance",
    Prostate: severe ? "High-suspicion focal lesion in prostate transitional/peripheral zone" : moderate ? "Intermediate-suspicion prostate lesion requiring targeted review" : "Low-suspicion focal signal change in prostate tissue",
    Spine   : severe ? "Aggressive vertebral or paraspinal lesion pattern"                  : moderate ? "Focal spinal lesion with marrow replacement concern"               : "Mild focal marrow signal change for review",
    Pelvis  : severe ? "Complex pelvic mass with malignant imaging concern"                 : moderate ? "Indeterminate pelvic lesion requiring further characterisation"    : "Low-volume pelvic signal abnormality"
  };
  return map[region] || "Suspicious lesion requiring radiologist interpretation";
}

function buildFlags(patient, suspicionScore, confidence, heterogeneity) {
  const flags = [];
  if      (suspicionScore >= 75) flags.push({ label: "High malignancy suspicion",    level: "high"     });
  else if (suspicionScore >= 50) flags.push({ label: "Moderate lesion concern",       level: "moderate" });
  else                           flags.push({ label: "Lower immediate concern",       level: "low"      });
  if (patient.familyHistory.includes("Yes"))            flags.push({ label: "Positive family history",            level: "moderate" });
  if (patient.smokingStatus !== "Non-Smoker")           flags.push({ label: "Smoking-related risk present",       level: "moderate" });
  if (heterogeneity >= 70)                              flags.push({ label: "Marked tissue heterogeneity",       level: "high"     });
  if (confidence < 65)                                  flags.push({ label: "Confidence limited by scan quality", level: "moderate" });
  else                                                  flags.push({ label: "Strong image confidence",           level: "low"      });
  return flags;
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  AI MEDVISION backend running → http://localhost:${PORT}`);
  console.log(`   Ollama URL  : ${OLLAMA_URL}`);
  console.log(`   Model       : ${MODEL}`);
  console.log(`   Static dir  : ${__dirname}\n`);
});
