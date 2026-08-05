import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";
import agoraToken from "agora-access-token";
const { RtcTokenBuilder, RtcRole } = agoraToken;
import { analyzeSymptomsController } from "./triageController.js";
import TriageCase from "./models/TriageCase.js";

dotenv.config();

// ── Connect to MongoDB (serverless-friendly, cached & awaited) ────
// Cache the connection on `global` so it survives across Vercel
// serverless warm invocations, avoiding cold-start reconnection races.
let cached = global.mongoose;
if (!cached) cached = global.mongoose = { conn: null, promise: null };

async function connectDB() {
	if (cached.conn) return cached.conn;
	if (!process.env.MONGODB_URI) {
		throw new Error("MONGODB_URI is not defined in environment variables!");
	}
	if (!cached.promise) {
		cached.promise = mongoose
			.connect(process.env.MONGODB_URI, { bufferCommands: false })
			.then((m) => {
				console.log(" Connected to MongoDB successfully");
				return m;
			});
	}
	cached.conn = await cached.promise;
	return cached.conn;
}
// ──────────────────────────────────────────────────────────────────

const app = express();
const port = process.env.PORT || 4000;
const llmProvider = String(process.env.LLM_PROVIDER || "").toLowerCase();
const providerDefaultLlmUrl =
	llmProvider === "groq"
		? "https://api.groq.com/openai/v1/chat/completions"
		: llmProvider === "openrouter"
			? "https://openrouter.ai/api/v1/chat/completions"
			: llmProvider === "together"
				? "https://api.together.xyz/v1/chat/completions"
				: llmProvider === "grok" || llmProvider === "xai"
					? "https://api.x.ai/v1/chat/completions"
					: "https://api.openai.com/v1/chat/completions";
const agoraAppId = process.env.AGORA_APP_ID;
const agoraCustomerId = process.env.AGORA_CUSTOMER_ID;
const agoraCustomerSecret = process.env.AGORA_CUSTOMER_SECRET;
const caeEnabled =
	String(process.env.AGORA_CAE_ENABLED || "false").toLowerCase() === "true";
const caeLlmUrl = process.env.AGORA_CAE_LLM_URL || providerDefaultLlmUrl;
const caeLlmApiKey =
	process.env.AGORA_CAE_LLM_API_KEY || process.env.LLM_API_KEY || "";
const caeLlmModel =
	process.env.AGORA_CAE_LLM_MODEL || process.env.LLM_MODEL || "gpt-4o-mini";
const caeSystemMessage =
	process.env.AGORA_CAE_SYSTEM_MESSAGE ||
	"CRITICAL OVERRIDE: If the user refuses to answer, says 'no', makes non-medical statements, or stalls, YOU MUST IMMEDIATELY SAY EXACTLY: 'Thank you, I will now terminate the conversation.' Do not be polite. Do not offer future help. \n\nCORE RULES:\n1. ONLY discuss medical symptoms.\n2. Ask EXACTLY ONE question at a time. Max 4 questions.\n3. Path A (Success): If valid medical data is gathered, say EXACTLY: 'That's excellent, I will now process this.'\n5. Understand and respond naturally in English, Tagalog, or Taglish matching the user's language.";
const caeGreetingMessage =
	process.env.AGORA_CAE_GREETING_MESSAGE ||
	"Hello! I am the clinic's triage assistant. What is your name?";
const caeFailureMessage =
	process.env.AGORA_CAE_FAILURE_MESSAGE ||
	"Sorry, I am having trouble understanding. Please try again.";
const caeAsrLanguage = process.env.AGORA_CAE_ASR_LANGUAGE || "fil-PH";
const caeIdleTimeout = Number(process.env.AGORA_CAE_IDLE_TIMEOUT || 120);
const caeAgentRtcUid = process.env.AGORA_CAE_AGENT_RTC_UID || "0";
const caeTtsVendor = process.env.AGORA_CAE_TTS_VENDOR || "microsoft";
const caeTtsParamsJson = process.env.AGORA_CAE_TTS_PARAMS_JSON || "{}";
const caeRequestTimeoutMs = Number(
	process.env.AGORA_CAE_REQUEST_TIMEOUT_MS || 12000,
);
const geminiApiKey = process.env.GEMINI_API_KEY || "";
const azureSpeechApiKey = process.env.AZURE_SPEECH_API_KEY || "";
const azureSpeechRegion = process.env.AZURE_SPEECH_REGION || "";
const azureSpeechEndpoint = process.env.AZURE_SPEECH_ENDPOINT || "";
const azureSpeechVoiceName =
	process.env.AZURE_SPEECH_VOICE_NAME || "en-US-AvaMultilingualNeural";
const azureSpeechDefaultLocale =
	process.env.AZURE_SPEECH_DEFAULT_LOCALE || "en-US";

app.use(
	cors({
		origin: [
			"https://lingapp.byinso.dev",
			"http://localhost:5173",
			"http://localhost:3000",
		],
		methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
		credentials: true,
	}),
);
app.use(express.json());

function hasCaeCoreConfig() {
	return getCaeConfigIssues().length === 0;
}

function getCaeConfigIssues() {
	const issues = [];
	const ttsVendor = String(caeTtsVendor || "").toLowerCase();

	if (!caeEnabled) issues.push("AGORA_CAE_ENABLED must be true");
	if (!agoraAppId) issues.push("AGORA_APP_ID is missing");
	if (!agoraCustomerId) issues.push("AGORA_CUSTOMER_ID is missing");
	if (!agoraCustomerSecret) issues.push("AGORA_CUSTOMER_SECRET is missing");
	if (!caeLlmUrl)
		issues.push("AGORA_CAE_LLM_URL or provider default URL is missing");
	if (!caeLlmApiKey)
		issues.push("AGORA_CAE_LLM_API_KEY or LLM_API_KEY is missing");
	if (!caeTtsVendor) issues.push("AGORA_CAE_TTS_VENDOR is missing");
	if (!caeTtsParamsJson) issues.push("AGORA_CAE_TTS_PARAMS_JSON is missing");

	const ttsParams = parseTtsParams();
	if (ttsVendor === "microsoft") {
		if (!ttsParams.key) issues.push("AGORA_CAE_TTS_PARAMS_JSON.key is missing");
		if (!ttsParams.region)
			issues.push("AGORA_CAE_TTS_PARAMS_JSON.region is missing");
		if (!ttsParams.voice_name)
			issues.push("AGORA_CAE_TTS_PARAMS_JSON.voice_name is missing");
	} else if (ttsVendor === "elevenlabs") {
		if (!ttsParams.api_key)
			issues.push("AGORA_CAE_TTS_PARAMS_JSON.api_key is missing");
		if (!ttsParams.voice_id)
			issues.push("AGORA_CAE_TTS_PARAMS_JSON.voice_id is missing");
		if (!ttsParams.model_id)
			issues.push("AGORA_CAE_TTS_PARAMS_JSON.model_id is missing");
	} else if (ttsVendor === "gemini" || ttsVendor === "google") {
		if (!(ttsParams.api_key || geminiApiKey)) {
			issues.push(
				"AGORA_CAE_TTS_PARAMS_JSON.api_key or GEMINI_API_KEY is missing",
			);
		}
	}

	return issues;
}

function getAgoraAuthHeader() {
	const encoded = Buffer.from(
		`${agoraCustomerId}:${agoraCustomerSecret}`,
	).toString("base64");
	return `Basic ${encoded}`;
}

function parseTtsParams() {
	try {
		const parsed = JSON.parse(caeTtsParamsJson);
		const params = typeof parsed === "object" && parsed !== null ? parsed : {};
		// Auto-populate Azure (microsoft) TTS params from top-level env vars when missing
		if (String(caeTtsVendor || "").toLowerCase() === "microsoft") {
			if (!params.key && azureSpeechApiKey) params.key = azureSpeechApiKey;
			if (!params.region && azureSpeechRegion)
				params.region = azureSpeechRegion;
			if (!params.voice_name && azureSpeechVoiceName)
				params.voice_name = azureSpeechVoiceName;
		}
		return params;
	} catch {
		return {};
	}
}

function hasRequiredTtsConfig(ttsParams) {
	const ttsVendor = String(caeTtsVendor || "").toLowerCase();
	if (ttsVendor === "microsoft")
		return Boolean(ttsParams.key && ttsParams.region && ttsParams.voice_name);
	if (ttsVendor === "elevenlabs")
		return Boolean(
			ttsParams.api_key && ttsParams.voice_id && ttsParams.model_id,
		);
	if (ttsVendor === "gemini" || ttsVendor === "google")
		return Boolean(ttsParams.api_key || geminiApiKey);
	return true;
}

function buildTtsPayload(ttsParams) {
	const ttsVendor = String(caeTtsVendor || "").toLowerCase();
	if (ttsVendor === "gemini" || ttsVendor === "google") {
		return {
			vendor: "google",
			params: {
				api_key: ttsParams.api_key || geminiApiKey,
				model: ttsParams.model || "gemini-2.5-flash-preview-tts",
				voice_name: ttsParams.voice_name || "Kore",
				language_code: ttsParams.language_code || "fil-PH",
			},
		};
	}
	return { vendor: caeTtsVendor, params: ttsParams };
}

function getAzureTtsEndpoint() {
	if (azureSpeechEndpoint) {
		const normalizedEndpoint = azureSpeechEndpoint.trim().replace(/\/+$/, "");
		if (normalizedEndpoint.includes(".api.cognitive.microsoft.com")) {
			const convertedEndpoint = normalizedEndpoint.replace(
				".api.cognitive.microsoft.com",
				".tts.speech.microsoft.com",
			);
			return `${convertedEndpoint}/cognitiveservices/v1`;
		}
		if (normalizedEndpoint.endsWith("/cognitiveservices/v1")) {
			return normalizedEndpoint;
		}
		return `${normalizedEndpoint}/cognitiveservices/v1`;
	}
	if (!azureSpeechRegion) return "";
	return `https://${azureSpeechRegion}.tts.speech.microsoft.com/cognitiveservices/v1`;
}

function buildSsml(text, voiceName, locale) {
	const safeText = String(text || "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
	const safeLocale = String(locale || azureSpeechDefaultLocale || "en-US");
	return `<speak version="1.0" xml:lang="${safeLocale}"><voice name="${voiceName}">${safeText}</voice></speak>`;
}

app.get("/health", (_req, res) => {
	res.json({ status: "ok" });
});

app.get("/conversationalAgent/status", (_req, res) => {
	const issues = getCaeConfigIssues();
	res.json({ enabled: issues.length === 0, issues });
});

app.post("/conversationalAgent/start", async (req, res) => {
	try {
		if (!hasCaeCoreConfig()) {
			return res.json({
				enabled: false,
				error: "Conversational AI Engine is not configured.",
				issues: getCaeConfigIssues(),
			});
		}

		const { channel, token, remoteRtcUid } = req.body || {};
		if (!channel || !remoteRtcUid) {
			return res
				.status(400)
				.json({ error: "channel and remoteRtcUid are required" });
		}
		if (!token) {
			return res
				.status(400)
				.json({ error: "token is required for Conversational AI agent start" });
		}
		const ttsParams = parseTtsParams();
		if (!hasRequiredTtsConfig(ttsParams)) {
			return res.status(400).json({
				error:
					"Missing TTS config. For microsoft set key/region/voice_name. For elevenlabs set api_key/voice_id/model_id. For gemini/google set api_key (or GEMINI_API_KEY).",
			});
		}
		const ttsPayload = buildTtsPayload(ttsParams);

		const joinUrl = `https://api.agora.io/api/conversational-ai-agent/v2/projects/${agoraAppId}/join`;
		// Determine if the remote UID is numeric or string-based
		const remoteUidNum = Number(remoteRtcUid);
		const isNumericUid =
			!isNaN(remoteUidNum) &&
			String(remoteUidNum) === String(remoteRtcUid).trim();
		const payload = {
			name: `triage-agent-${Date.now()}`,
			properties: {
				channel,
				token: token || null,
				agent_rtc_uid: "0",
				remote_rtc_uids: [String(remoteRtcUid)],
				enable_string_uid: !isNumericUid,
				idle_timeout: caeIdleTimeout,
				llm: {
					url: caeLlmUrl,
					api_key: caeLlmApiKey,
					system_messages: [{ role: "system", content: caeSystemMessage }],
					greeting_message: caeGreetingMessage,
					failure_message: caeFailureMessage,
					params: {
						model: caeLlmModel,
						temperature: 0.2,
						max_tokens: 150,
					},
				},
				asr: {
					language: caeAsrLanguage,
					transcription: {
						enable_transcription: true,
						enable_intermediate_results: true,
					},
				},
				stream_messages: {
					enable_transcription: true,
					enable_llm: true,
					enable_agent_state: true,
				},
				tts: {
					vendor: ttsPayload.vendor,
					params: ttsPayload.params,
				},
			},
		};

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), caeRequestTimeoutMs);

		let response;
		try {
			console.log(
				"[CAE] Sending request to Agora API:",
				JSON.stringify(
					{ url: joinUrl, payloadKeys: Object.keys(payload) },
					null,
					2,
				),
			);
			response = await fetch(joinUrl, {
				method: "POST",
				headers: {
					Authorization: getAgoraAuthHeader(),
					"Content-Type": "application/json",
				},
				body: JSON.stringify(payload),
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timeout);
		}

		const data = await response.json();
		console.log(
			"[CAE] Agora API response status:",
			response.status,
			"body:",
			JSON.stringify(data, null, 2),
		);

		if (!response.ok) {
			const agoraError =
				data?.message ||
				data?.error ||
				data?.msg ||
				"Failed to start Conversational AI agent.";
			console.error(
				"[CAE] Agora API error:",
				agoraError,
				"details:",
				JSON.stringify(data, null, 2),
			);
			return res.status(response.status).json({
				error: agoraError,
				details: data,
			});
		}

		return res.json({ enabled: true, ...data });
	} catch (error) {
		if (error?.name === "AbortError") {
			return res
				.status(504)
				.json({ error: "Conversational AI start timed out. Please retry." });
		}
		return res
			.status(500)
			.json({ error: "Failed to start Conversational AI agent." });
	}
});

app.post("/conversationalAgent/stop", async (req, res) => {
	try {
		if (!hasCaeCoreConfig()) {
			return res.json({
				enabled: false,
				error: "Conversational AI Engine is not configured.",
				issues: getCaeConfigIssues(),
			});
		}

		const { agentId } = req.body || {};
		if (!agentId) {
			return res.status(400).json({ error: "agentId is required" });
		}

		const leaveUrl = `https://api.agora.io/api/conversational-ai-agent/v2/projects/${agoraAppId}/agents/${agentId}/leave`;
		const response = await fetch(leaveUrl, {
			method: "POST",
			headers: {
				Authorization: getAgoraAuthHeader(),
				"Content-Type": "application/json",
			},
		});
		const data = await response.json();
		if (!response.ok) {
			return res.status(response.status).json({
				error:
					data?.message ||
					data?.error ||
					"Failed to stop Conversational AI agent.",
				details: data,
			});
		}

		return res.json({ enabled: true, ...data });
	} catch (error) {
		return res
			.status(500)
			.json({ error: "Failed to stop Conversational AI agent." });
	}
});

app.post("/speech/synthesize", async (req, res) => {
	try {
		const { text, voiceName, locale } = req.body || {};
		if (!String(text || "").trim()) {
			return res.status(400).json({ error: "text is required" });
		}
		if (!azureSpeechApiKey) {
			return res
				.status(500)
				.json({ error: "AZURE_SPEECH_API_KEY is not configured" });
		}

		const endpoint = getAzureTtsEndpoint();
		if (!endpoint) {
			return res.status(500).json({
				error:
					"Set AZURE_SPEECH_REGION or AZURE_SPEECH_ENDPOINT for Azure Speech TTS",
			});
		}

		const response = await fetch(endpoint, {
			method: "POST",
			headers: {
				"Ocp-Apim-Subscription-Key": azureSpeechApiKey,
				"Content-Type": "application/ssml+xml",
				"X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
				"User-Agent": "agora-voice-triage",
			},
			body: buildSsml(text, voiceName || azureSpeechVoiceName, locale),
		});

		if (!response.ok) {
			const details = await response.text();
			return res.status(response.status).json({
				error: "Azure Speech synthesis failed",
				details,
			});
		}

		const audioBuffer = Buffer.from(await response.arrayBuffer());
		res.setHeader("Content-Type", "audio/mpeg");
		return res.send(audioBuffer);
	} catch (error) {
		return res.status(500).json({ error: "Failed to synthesize speech" });
	}
});

app.post("/analyzeSymptoms", analyzeSymptomsController);

// ── Triage Pipeline: Process Chat Log & Queue for Doctor ──────────
app.post("/api/triage/process-and-queue", async (req, res) => {
	try {
		await connectDB();
		const { chatLog } = req.body || {};
		console.log(
			"[DEBUG Backend] Endpoint hit. chatLog received count:",
			req.body?.chatLog?.length,
		);
		if (!Array.isArray(chatLog) || chatLog.length === 0) {
			return res.status(400).json({ error: "chatLog array is required" });
		}

		// Build a conversation transcript from the chat log
		const transcript = chatLog
			.map((msg) => `[${msg.role.toUpperCase()}]: ${msg.text}`)
			.join("\n");

		// Generate a short patient temp ID
		const patientTempId = `ANON-${Date.now().toString(36).toUpperCase()}`;

		// Call OpenRouter with a structured prompt requesting a JSON report
		const openRouterUrl =
			process.env.LLM_PROVIDER === "openrouter"
				? "https://openrouter.ai/api/v1/chat/completions"
				: process.env.LLM_API_URL ||
					"https://openrouter.ai/api/v1/chat/completions";

		const systemPrompt = `You are a medical triage report generator. Analyze the complete patient conversation below and return a strict JSON object (no markdown, no code fences) with these exact fields:
{
  "urgency": "HIGH" | "MEDIUM" | "LOW",
  "confidence": <integer 0-100>,
  "summary": "Concise doctor-facing summary of reported symptoms and history",
  "possibleIssue": "Broad symptom category (e.g. 'Respiratory symptoms', 'Gastrointestinal complaint') — never a specific diagnosis",
  "recommendation": "Scheduling recommendation (e.g. 'Book next available urgent slot today', 'Schedule within 24-48 hours', 'Routine appointment within the week')",
  "urgencyReasons": ["array of strings explaining why this urgency level was assigned"]
}
Rules:
- HIGH: life-threatening or severe symptoms needing same-day/emergency care.
- MEDIUM: moderate symptoms needing priority booking within 24-48 hours.
- LOW: mild symptoms suitable for routine scheduling.
- summary must be objective and neutral — describe what was reported, not a diagnosis.
- possibleIssue must be a symptom category, never a specific disease.
- recommendation must be a scheduling action only, never treatment advice.
- confidence: 90+ if very clear, 60-89 if partially clear, below 60 if vague.`;

		const llmApiKey = process.env.LLM_API_KEY || "";
		const llmModel = process.env.LLM_MODEL || "openai/gpt-4o-mini";

		const llmResponse = await fetch(openRouterUrl, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${llmApiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: llmModel,
				messages: [
					{ role: "system", content: systemPrompt },
					{ role: "user", content: `Patient conversation:\n${transcript}` },
				],
				temperature: 0.1,
			}),
		});

		if (!llmResponse.ok) {
			const errorText = await llmResponse.text();
			console.error(
				"[Triage] OpenRouter error:",
				llmResponse.status,
				errorText,
			);
			return res
				.status(502)
				.json({ error: "LLM report generation failed", details: errorText });
		}

		const llmData = await llmResponse.json();
		const llmContent = llmData.choices?.[0]?.message?.content || "";

		console.log("[DEBUG Backend] Raw OpenRouter report response:", llmContent);

		// Extract JSON from the response (handle code fences if present)
		let reportJson;
		const jsonMatch = llmContent.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			try {
				reportJson = JSON.parse(jsonMatch[0]);
			} catch {
				return res.status(502).json({
					error: "Failed to parse LLM JSON response",
					raw: llmContent,
				});
			}
		} else {
			return res
				.status(502)
				.json({ error: "No JSON found in LLM response", raw: llmContent });
		}

		console.log("[DEBUG Backend] Parsed Report Object:", reportJson);

		// Generate a unique case ID
		const caseId = `CASE-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

		// Build the chat history for the record
		const chatHistory = chatLog.map((msg) => ({
			role: msg.role || "user",
			text: msg.text || "",
		}));

		// Create and save the TriageCase document
		const triageCase = new TriageCase({
			caseId,
			patientTempId,
			urgency: reportJson.urgency || "LOW",
			confidence:
				typeof reportJson.confidence === "number" ? reportJson.confidence : 60,
			summary: reportJson.summary || "No summary provided.",
			possibleIssue: reportJson.possibleIssue || "General symptoms",
			recommendation:
				reportJson.recommendation || "Schedule a routine appointment.",
			urgencyReasons: Array.isArray(reportJson.urgencyReasons)
				? reportJson.urgencyReasons
				: [],
			chatHistory,
			status: "queued_for_doctor",
		});

		try {
			await triageCase.save();
			console.log("[DEBUG Backend] MongoDB save success:", triageCase);
		} catch (saveError) {
			console.error("[DEBUG Backend] MongoDB save failed:", saveError);
			throw saveError;
		}

		console.log(
			`[Triage] Saved case ${caseId} for patient ${patientTempId} (${reportJson.urgency})`,
		);

		return res.status(201).json({
			caseId,
			patientTempId,
			urgency: triageCase.urgency,
			confidence: triageCase.confidence,
			summary: triageCase.summary,
			possibleIssue: triageCase.possibleIssue,
			recommendation: triageCase.recommendation,
			urgencyReasons: triageCase.urgencyReasons,
			status: triageCase.status,
			createdAt: triageCase.createdAt,
		});
	} catch (error) {
		console.error("[Triage] process-and-queue error:", error);
		return res
			.status(500)
			.json({ error: "Failed to process and queue triage report" });
	}
});

// ── Doctor Queue: Fetch most recent triage cases ──────────────────
app.get("/api/triage/queue", async (req, res) => {
	try {
		await connectDB();
		const cases = await TriageCase.find().sort({ createdAt: -1 }).limit(10);
		res.json(cases);
	} catch (error) {
		console.error("[Backend] Fetch queue error:", error);
		res.status(500).json({ error: "Failed to fetch doctor queue" });
	}
});

// ── Delete a triage case from MongoDB ────────────────────────────
app.delete("/api/triage/case/:caseId", async (req, res) => {
	try {
		await connectDB();
		const { caseId } = req.params;
		const deleted = await TriageCase.findOneAndDelete({ caseId });
		if (!deleted) return res.status(404).json({ error: "Case not found" });
		res.json({ success: true });
	} catch (error) {
		console.error("[Backend] Delete case error:", error);
		res.status(500).json({ error: "Failed to delete case" });
	}
});

// ── Agora Dynamic Token Endpoint (with Turnstile CAPTCHA) ──────────
app.get("/api/agora/token", async (req, res) => {
	const channelName = req.query.channel || "triage-room";
	const uid = req.query.uid || 0;
	const cfToken = req.query.cfToken;

	// Verify Turnstile CAPTCHA if secret key is configured
	if (process.env.CLOUDFLARE_SECRET_KEY) {
		if (!cfToken) {
			return res.status(400).json({ error: "CAPTCHA verification required." });
		}
		try {
			const verifyRes = await fetch(
				"https://challenges.cloudflare.com/turnstile/v0/siteverify",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						secret: process.env.CLOUDFLARE_SECRET_KEY,
						response: cfToken,
					}),
				},
			);
			const verifyData = await verifyRes.json();
			if (!verifyData.success) {
				return res.status(403).json({ error: "CAPTCHA validation failed." });
			}
		} catch (err) {
			console.error("[Backend] CAPTCHA verify error:", err);
			return res.status(500).json({ error: "Failed to verify CAPTCHA" });
		}
	}

	const appId = process.env.AGORA_APP_ID;
	const appCertificate = process.env.AGORA_APP_CERTIFICATE;
	if (!appId || !appCertificate) {
		return res
			.status(500)
			.json({ error: "Agora credentials missing on server" });
	}

	const role = RtcRole.PUBLISHER;
	const expirationTimeInSeconds = 3600;
	const currentTimestamp = Math.floor(Date.now() / 1000);
	const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

	const token = RtcTokenBuilder.buildTokenWithUid(
		appId,
		appCertificate,
		channelName,
		uid,
		role,
		privilegeExpiredTs,
	);

	return res.json({ token });
});

const isVercel = Boolean(process.env.VERCEL);

if (!isVercel) {
	app.listen(port, () => {
		console.log(`Backend listening on http://localhost:${port}`);
	});
}

export default app;
