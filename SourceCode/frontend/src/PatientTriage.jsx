import { useEffect, useRef, useState } from "react";
import AgoraRTC from "agora-rtc-sdk-ng";
import UrgencyBadge from "./components/UrgencyBadge";

const API_BASE_URL =
	import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";
const AGORA_APP_ID = import.meta.env.VITE_AGORA_APP_ID;
const AGORA_CHANNEL = import.meta.env.VITE_AGORA_CHANNEL || "triage-room";
const AGORA_TOKEN = import.meta.env.VITE_AGORA_TOKEN || null;
const ENABLE_CONVERSATIONAL_AI =
	String(
		import.meta.env.VITE_ENABLE_CONVERSATIONAL_AI || "false",
	).toLowerCase() === "true";
const CAE_START_TIMEOUT_MS = 12000;
const SESSION_DURATION_MS = 300000; // 5 minutes hard limit
const SESSION_WARNING_MS = 30000; // warn user 30 seconds before timeout
const TRIAGE_RESULT_STORAGE_KEY = "patient-triage-analysis";

function PatientTriage({ onNewCase }) {
	const [isListening, setIsListening] = useState(false);
	const [chatLog, setChatLog] = useState([]);
	const [analysis, setAnalysis] = useState(null);
	const [error, setError] = useState("");
	const [caeStatus, setCaeStatus] = useState("idle");
	const [caeErrorText, setCaeErrorText] = useState("");
	const [isTriageComplete, setIsTriageComplete] = useState(false);
	const [isAborted, setIsAborted] = useState(false);
	const [sessionTimeLeft, setSessionTimeLeft] = useState(null);
	const [isSessionEnding, setIsSessionEnding] = useState(false);
	const [isGeneratingReport, setIsGeneratingReport] = useState(false);

	const agoraClientRef = useRef(null);
	const reportRef = useRef(null);
	const sessionTimerRef = useRef(null);
	const sessionCountdownRef = useRef(null);
	const localTrackRef = useRef(null);
	const caeAgentIdRef = useRef(null);
	const chatLogRef = useRef(null);
	const messagesEndRef = useRef(null);
	const isStreamingRef = useRef(false);
	const latestChatLogRef = useRef([]);
	const streamChunksRef = useRef({});
	const isProcessingRef = useRef(false);
	const activeUserMsgIdRef = useRef(null);
	const activeAiMsgIdRef = useRef(null);
	useEffect(() => {
		try {
			const raw = localStorage.getItem(TRIAGE_RESULT_STORAGE_KEY);
			if (!raw) return;
			const saved = JSON.parse(raw);
			if (saved?.analysis) {
				setAnalysis(saved.analysis);
			}
		} catch {
			localStorage.removeItem(TRIAGE_RESULT_STORAGE_KEY);
		}
	}, []);

	useEffect(() => {
		if (!analysis) {
			localStorage.removeItem(TRIAGE_RESULT_STORAGE_KEY);
			return;
		}
		localStorage.setItem(
			TRIAGE_RESULT_STORAGE_KEY,
			JSON.stringify({ analysis }),
		);
	}, [analysis]);

	useEffect(() => {
		return () => {
			cleanupAgora();
		};
	}, []);

	// Auto-scroll chat log to the latest message smoothly
	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [chatLog]);

	useEffect(() => {
		if (isGeneratingReport || analysis) {
			setTimeout(() => {
				reportRef.current?.scrollIntoView({
					behavior: "smooth",
					block: "start",
				});
			}, 100);
		}
	}, [isGeneratingReport, analysis]);

	const deleteTriageResult = async () => {
		if (analysis?.caseId) {
			try {
				await fetch(`${API_BASE_URL}/api/triage/case/${analysis.caseId}`, {
					method: "DELETE",
				});
			} catch (error) {
				console.error("Failed to delete result from DB:", error);
			}
		}
		setAnalysis(null);
		setIsTriageComplete(false);
	};

	const startConversationalAgent = async (remoteRtcUid) => {
		if (!ENABLE_CONVERSATIONAL_AI) {
			setCaeStatus("disabled");
			setCaeErrorText("");
			return;
		}
		if (!AGORA_TOKEN) {
			setCaeStatus("error");
			setCaeErrorText("Missing Agora token for Conversational AI.");
			return;
		}
		setCaeStatus("starting");
		setCaeErrorText("");
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), CAE_START_TIMEOUT_MS);
		try {
			const statusResponse = await fetch(
				`${API_BASE_URL}/conversationalAgent/status`,
			);
			if (statusResponse.ok) {
				const statusData = await statusResponse.json();
				if (!statusData.enabled) {
					setCaeStatus("disabled");
					const issuesText =
						Array.isArray(statusData.issues) && statusData.issues.length
							? statusData.issues.join(", ")
							: "Backend reports CAE as disabled. Restart backend after updating .env.";
					setCaeErrorText(issuesText);
					return;
				}
			}

			const response = await fetch(
				`${API_BASE_URL}/conversationalAgent/start`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						channel: AGORA_CHANNEL,
						token: AGORA_TOKEN,
						remoteRtcUid: String(remoteRtcUid),
					}),
					signal: controller.signal,
				},
			);
			const data = await response.json();
			console.log(
				"[CAE] Start response:",
				response.status,
				JSON.stringify(data, null, 2),
			);
			if (!response.ok)
				throw new Error(
					data.error ||
						data.details?.message ||
						"Failed to start conversational agent.",
				);
			if (!data.enabled) {
				setCaeStatus("disabled");
				const issuesText =
					Array.isArray(data.issues) && data.issues.length
						? data.issues.join(", ")
						: "Backend reports CAE as disabled. Restart backend after updating .env.";
				setCaeErrorText(
					`${data.error ? `${data.error}. ` : ""}${issuesText}`.trim(),
				);
				return;
			}
			caeAgentIdRef.current = data.agent_id || data.agentId || null;
			setCaeStatus(caeAgentIdRef.current ? "connected" : "error");
			if (!caeAgentIdRef.current) {
				setCaeErrorText("Agent started but no agent id was returned.");
			}
		} catch (error) {
			setCaeStatus("error");
			setCaeErrorText(
				error?.name === "AbortError"
					? "Agent start timed out."
					: error?.message || "Agent start failed.",
			);
			console.error(error);
		} finally {
			clearTimeout(timeout);
		}
	};

	const stopConversationalAgent = async () => {
		if (!caeAgentIdRef.current) return;
		try {
			await fetch(`${API_BASE_URL}/conversationalAgent/stop`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ agentId: caeAgentIdRef.current }),
			});
		} catch (error) {
			console.error(error);
		} finally {
			caeAgentIdRef.current = null;
			setCaeErrorText("");
			if (ENABLE_CONVERSATIONAL_AI) setCaeStatus("idle");
		}
	};

	const startSessionTimer = () => {
		// Clear any previous timers
		clearTimeout(sessionTimerRef.current);
		clearInterval(sessionCountdownRef.current);
		setSessionTimeLeft(SESSION_DURATION_MS);
		setIsSessionEnding(false);

		// Update the countdown display every second
		const startTime = Date.now();
		sessionCountdownRef.current = setInterval(() => {
			const elapsed = Date.now() - startTime;
			const remaining = Math.max(0, SESSION_DURATION_MS - elapsed);
			setSessionTimeLeft(remaining);
			if (remaining <= 0) {
				clearInterval(sessionCountdownRef.current);
			}
		}, 1000);

		// Hard limit: end the session after SESSION_DURATION_MS
		sessionTimerRef.current = setTimeout(() => {
			handleSessionTimeout();
		}, SESSION_DURATION_MS);
	};

	const clearSessionTimer = () => {
		clearTimeout(sessionTimerRef.current);
		sessionTimerRef.current = null;
		clearInterval(sessionCountdownRef.current);
		sessionCountdownRef.current = null;
		setSessionTimeLeft(null);
		setIsSessionEnding(false);
	};

	const handleSessionTimeout = () => {
		if (!isStreamingRef.current || isProcessingRef.current) return;
		setIsSessionEnding(true);

		// Add a system notice to the chat log
		const systemMsg = {
			id: `session_timeout_${Date.now()}`,
			role: "system",
			text: "⏰ The 5-minute session has ended. The conversation so far will now be processed for triage.",
			isFinal: true,
		};
		setChatLog((prev) => {
			const next = [...prev, systemMsg];
			latestChatLogRef.current = next;
			return next;
		});

		// Brief delay so the user can read the message before cleanup
		setTimeout(() => {
			processAndQueueReport();
		}, 2000);
	};

	const startAgoraStreaming = async () => {
		if (!AGORA_APP_ID) {
			console.warn("Agora APP ID missing — cannot continue without Agora.");
			setCaeStatus("disabled");
			setError(
				"Agora APP ID is not configured. Set VITE_AGORA_APP_ID in .env.",
			);
			return;
		}
		const client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
		try {
			client.on("user-published", async (user, mediaType) => {
				await client.subscribe(user, mediaType);
				if (mediaType === "audio") {
					user.audioTrack?.play();
				}
			});

			client.on("user-unpublished", (user, mediaType) => {
				if (mediaType === "audio") {
					user.audioTrack?.stop();
				}
			});

			client.on("stream-message", (uid, data) => {
				handleStreamMessage(uid, data);
			});

			const micTrack = await AgoraRTC.createMicrophoneAudioTrack();
			const safeUid = Math.floor(Math.random() * 2147483647) + 1;
			const localUid = await client.join(
				AGORA_APP_ID,
				AGORA_CHANNEL,
				AGORA_TOKEN,
				safeUid,
			);
			await client.publish([micTrack]);
			agoraClientRef.current = client;
			localTrackRef.current = micTrack;
			isStreamingRef.current = true;
			setIsListening(true);
			await startConversationalAgent(localUid);
			// Start the 5-minute session timer after successful connection
			startSessionTimer();
		} catch (error) {
			client.removeAllListeners();
			try {
				await client.leave();
			} catch {}
			throw new Error(error?.message || "Failed to connect to Agora channel.");
		}
	};

	const cleanupAgora = async () => {
		clearSessionTimer();
		try {
			await stopConversationalAgent();
			if (localTrackRef.current) {
				localTrackRef.current.stop();
				localTrackRef.current.close();
			}
			if (agoraClientRef.current) {
				agoraClientRef.current.removeAllListeners();
				await agoraClientRef.current.leave();
			}
		} catch (e) {
			console.error("Agora cleanup error:", e);
		} finally {
			localTrackRef.current = null;
			agoraClientRef.current = null;
			isStreamingRef.current = false;
			setIsListening(false);
		}
	};

	const handleStreamMessage = (uid, data) => {
		if (!isStreamingRef.current) return;

		/** Decode Base64 to UTF-8 string. */
		const decodeBase64 = (str) => {
			try {
				return decodeURIComponent(
					atob(str)
						.split("")
						.map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
						.join(""),
				);
			} catch {
				return atob(str);
			}
		};

		/** Extract a readable string from the raw Agora data. */
		const getRawString = (input) => {
			if (typeof input === "string") return input;
			if (input instanceof ArrayBuffer || input instanceof Uint8Array) {
				try {
					return new TextDecoder().decode(input);
				} catch {
					return null;
				}
			}
			return null;
		};

		/** Try to parse as a chunked stream message: msgId|chunkIndex|totalChunks|base64Payload */
		const tryChunkedMessage = (raw) => {
			const parts = raw.split("|");
			if (parts.length < 4) return null;
			const [msgId, chunkIndexStr, totalChunksStr, ...rest] = parts;
			const chunkIndex = parseInt(chunkIndexStr, 10);
			const totalChunks = parseInt(totalChunksStr, 10);
			if (
				isNaN(chunkIndex) ||
				isNaN(totalChunks) ||
				chunkIndex < 1 ||
				totalChunks < 1
			)
				return null;
			return { msgId, chunkIndex, totalChunks, base64Payload: rest.join("|") };
		};

		/** Upsert a message into chatLog (update by id, or append). */
		const upsertMessage = (id, role, text, isFinal) => {
			setChatLog((prev) => {
				const idx = prev.findIndex((m) => m.id === id);
				if (idx >= 0) {
					const next = [...prev];
					next[idx] = { ...next[idx], text, isFinal };
					latestChatLogRef.current = next;
					return next;
				}
				const next = [...prev, { id, role, text, isFinal }];
				latestChatLogRef.current = next;
				return next;
			});
		};

		const raw = getRawString(data);
		if (!raw) {
			console.log(
				"[CAE] Stream message could not be decoded as string from uid:",
				uid,
				"type:",
				typeof data,
			);
			return;
		}

		// --- Attempt chunked stream message parsing first ---
		const chunked = tryChunkedMessage(raw);
		if (chunked) {
			const { msgId, chunkIndex, totalChunks, base64Payload } = chunked;

			// Initialise buffer for this msgId
			if (!streamChunksRef.current[msgId]) {
				streamChunksRef.current[msgId] = {};
			}

			// Store this chunk at its 1-based index
			streamChunksRef.current[msgId][chunkIndex] = base64Payload;

			// Check whether all chunks have arrived
			const chunks = streamChunksRef.current[msgId];
			if (Object.keys(chunks).length === totalChunks) {
				// Concatenate in correct order (1 … totalChunks)
				let concatenatedBase64 = "";
				for (let i = 1; i <= totalChunks; i++) {
					if (chunks[i]) {
						concatenatedBase64 += chunks[i];
					} else {
						console.error(
							`Missing chunk ${i}/${totalChunks} for msgId ${msgId}`,
						);
						delete streamChunksRef.current[msgId];
						return;
					}
				}

				// Free memory — we no longer need the buffer for this msgId
				delete streamChunksRef.current[msgId];

				// Decode from Base64 → UTF-8 → JSON
				const decodedJson = decodeBase64(concatenatedBase64);
				let parsed;
				try {
					parsed = JSON.parse(decodedJson);
				} catch {
					console.error(
						"Failed to parse decoded stream message as JSON:",
						decodedJson,
					);
					return;
				}

				console.log("Agora Stream Payload:", parsed);

				const text = parsed.text || parsed.transcript || "";
				if (!text) return;

				const role =
					parsed.object === "assistant.transcription" ? "ai" : "user";
				const isFinal = parsed.turn_status === 1 || parsed.is_final === true;
				const turnId = parsed.turn_id;
				const stableId =
					turnId !== undefined
						? `${role}_turn_${turnId}`
						: `${role}_current_turn`;

				upsertMessage(stableId, role, text, isFinal);

				// Check for specific AI end phrases
				const textLower1 = text.toLowerCase();
				const hasSuccessPhrase1 = textLower1.includes(
					"i will now process this",
				);
				const hasAbortPhrase1 =
					textLower1.includes("i will now terminate the conversation") ||
					textLower1.includes("take care") ||
					textLower1.includes("goodbye") ||
					textLower1.includes("change your mind") ||
					textLower1.includes("feel free to");
				const isOverLimit1 = latestChatLogRef.current.length >= 80;

				if (isFinal) {
					if ((role === "ai" && hasSuccessPhrase1) || isOverLimit1) {
						processAndQueueReport();
					} else if (role === "ai" && hasAbortPhrase1) {
						abortPointlessTriage();
					}
				}

				if (isFinal && turnId === undefined) {
					const ref = role === "user" ? activeUserMsgIdRef : activeAiMsgIdRef;
					ref.current = null;
				}
			}
			return; // fully handled chunked message
		}

		// --- Fallback: plain JSON / raw string ---
		let text = "";
		let role = "user";
		let isFinal = true;

		const tryParse = (raw) => {
			try {
				const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
				const msgType = String(parsed.type || "").toLowerCase();
				if (msgType && msgType !== "transcription") return null;
				const text = parsed.text || parsed.transcript || parsed.data || "";
				const role =
					parsed.object === "user.transcription"
						? "user"
						: parsed.object === "assistant.transcription"
							? "ai"
							: null;
				if (parsed.object && !role) return { ignored: true };
				const isFinal = parsed.turn_status === 1 || parsed.is_final === true;
				const turnId = parsed.turn_id;
				return { text, role: role || "user", isFinal, turnId };
			} catch {
				return null;
			}
		};

		const result = tryParse(raw);
		if (result?.ignored) return;
		if (result) {
			text = result.text;
			role = result.role || "user";
			isFinal = result.isFinal;
			const turnId = result.turnId;

			const stableId =
				turnId !== undefined
					? `${role}_turn_${turnId}`
					: `${role}_current_turn`;

			upsertMessage(stableId, role, text, isFinal);

			// Check for specific AI end phrases
			const textLower2 = text.toLowerCase();
			const hasSuccessPhrase2 = textLower2.includes("i will now process this");
			const hasAbortPhrase2 =
				textLower2.includes("i will now terminate the conversation") ||
				textLower2.includes("take care") ||
				textLower2.includes("goodbye") ||
				textLower2.includes("change your mind") ||
				textLower2.includes("feel free to");
			const isOverLimit2 = latestChatLogRef.current.length >= 80;

			if (isFinal) {
				if ((role === "ai" && hasSuccessPhrase2) || isOverLimit2) {
					processAndQueueReport();
				} else if (role === "ai" && hasAbortPhrase2) {
					abortPointlessTriage();
				}
			}

			if (isFinal && turnId === undefined) {
				const ref = role === "user" ? activeUserMsgIdRef : activeAiMsgIdRef;
				ref.current = null;
			}
		} else {
			text = raw;
		}

		if (!text) return;

		const fallbackId = `msg_${Date.now()}_${Math.random()
			.toString(36)
			.slice(2, 8)}`;
		upsertMessage(fallbackId, role, text, isFinal);

		// Check for specific AI end phrases
		const textLower3 = text.toLowerCase();
		const hasSuccessPhrase3 = textLower3.includes("i will now process this");
		const hasAbortPhrase3 =
			textLower3.includes("i will now terminate the conversation") ||
			textLower3.includes("take care") ||
			textLower3.includes("goodbye") ||
			textLower3.includes("change your mind") ||
			textLower3.includes("feel free to");
		const isOverLimit3 = latestChatLogRef.current.length >= 80;

		if (isFinal) {
			if ((role === "ai" && hasSuccessPhrase3) || isOverLimit3) {
				processAndQueueReport();
			} else if (role === "ai" && hasAbortPhrase3) {
				abortPointlessTriage();
			}
		}
	};

	const processAndQueueReport = async () => {
		if (isProcessingRef.current) return;
		isProcessingRef.current = true;
		if (!isStreamingRef.current) return;
		// Cut the audio connection instantly
		cleanupAgora();
		setIsTriageComplete(true);
		setIsGeneratingReport(true);
		try {
			// Build the chat log from current state
			const currentChatLog = latestChatLogRef.current
				.filter((m) => m.text && m.text.trim() !== "")
				.map((m) => ({ role: m.role, text: m.text }));

			if (currentChatLog.length === 0) return;

			console.log("[Triage] Processing and queuing report...");

			console.log(
				"[DEBUG Frontend] Sending chatLog to backend:",
				currentChatLog,
			);

			const response = await fetch(
				`${API_BASE_URL}/api/triage/process-and-queue`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ chatLog: currentChatLog }),
				},
			);

			console.log("[DEBUG Frontend] Backend response status:", response.status);

			const report = await response.json();
			console.log("[DEBUG Frontend] Backend response data:", report);

			if (!response.ok) {
				throw new Error(report.error || `HTTP ${response.status}`);
			}

			console.log("[Triage] Report received:", report);

			// Set the analysis state to render the triage result card
			setAnalysis({
				urgency: report.urgency,
				confidence: report.confidence,
				summary: report.summary,
				possible_issue: report.possibleIssue,
				recommendation: report.recommendation,
				urgency_reasons: report.urgencyReasons,
				caseId: report.caseId,
				status: report.status,
			});
			setIsGeneratingReport(false);
		} catch (error) {
			console.error("[Triage] processAndQueueReport error:", error);
			setIsGeneratingReport(false);
			setError(error?.message || "Failed to generate triage report.");
		}
	};

	const abortPointlessTriage = async () => {
		if (!isStreamingRef.current) return;
		cleanupAgora();
		setIsTriageComplete(true);
		setIsAborted(true);
		setIsGeneratingReport(false);
	};

	const toggleTriage = async () => {
		setIsAborted(false);
		setIsTriageComplete(false);
		setIsGeneratingReport(false);
		setIsSessionEnding(false);
		setSessionTimeLeft(null);
		setError("");
		isProcessingRef.current = false;
		if (isListening) {
			isStreamingRef.current = false;
			await cleanupAgora();
			return;
		}
		try {
			setChatLog([]);
			chatLogRef.current = null;
			setAnalysis(null);
			setCaeStatus("starting");
			setCaeErrorText("");
			await startAgoraStreaming();
		} catch (e) {
			setCaeStatus("error");
			setCaeErrorText(e?.message || "Failed to connect to Agora or start CAE.");
			setError("Failed to start microphone or Agora connection.");
			console.error(e);
			isStreamingRef.current = false;
			await cleanupAgora();
		}
	};

	const urgencyPanelStyle = {
		HIGH: "border-red-200 bg-red-50",
		MEDIUM: "border-orange-200 bg-orange-50",
		LOW: "border-green-200 bg-green-50",
	};
	const confidenceBarColor = (c) =>
		c >= 80 ? "bg-green-500" : c >= 60 ? "bg-orange-400" : "bg-red-400";
	const confidenceTextColor = (c) =>
		c >= 80 ? "text-green-700" : c >= 60 ? "text-orange-600" : "text-red-600";

	return (
		<section className="space-y-5">
			<div className="rounded-3xl border border-slate-200 bg-white/85 p-5 shadow-sm">
				<h2 className="font-headline text-2xl font-bold text-slate-900">
					Patient Voice Triage
				</h2>
				<p className="text-slate-600">
					Supports English, Tagalog, and Taglish symptom descriptions.
				</p>
			</div>

			<div className="grid gap-4 md:grid-cols-2">
				<div className="flex flex-col items-center rounded-3xl border border-slate-200 bg-white/90 p-6 shadow-sm">
					<button
						onClick={toggleTriage}
						className={`flex h-40 w-40 items-center justify-center rounded-full text-center font-headline text-xl font-bold text-white shadow-lg transition duration-200 hover:scale-105 ${
							isListening
								? "bg-red-500 hover:bg-red-600"
								: "bg-slate-900 hover:bg-slate-700"
						}`}
					>
						{isTriageComplete
							? "Start New Triage"
							: isListening
								? "Stop Triage"
								: "Start Triage"}
					</button>

					<p className="mt-4 text-center text-sm text-slate-500">
						{isListening
							? "Listening. Click to stop."
							: "Click and describe symptoms clearly."}
					</p>
					<p className="mt-2 text-center text-xs text-slate-500">
						{caeStatus === "connected"
							? "Conversational AI agent is active."
							: caeStatus === "starting"
								? "Starting conversational AI agent..."
								: caeStatus === "error"
									? `Conversational AI agent failed to start.${caeErrorText ? ` ${caeErrorText}` : ""}`
									: caeStatus === "disabled"
										? `Conversational AI agent is disabled.${caeErrorText ? ` ${caeErrorText}` : ""}`
										: ""}
					</p>
					{sessionTimeLeft !== null && isListening && !isSessionEnding && (
						<div className="mt-3 flex items-center justify-center gap-1.5">
							<div
								className={`h-2 w-2 rounded-full ${
									sessionTimeLeft <= SESSION_WARNING_MS
										? "animate-pulse bg-red-500"
										: "bg-emerald-500"
								}`}
							/>
							<span
								className={`text-xs font-semibold ${
									sessionTimeLeft <= SESSION_WARNING_MS
										? "text-red-600"
										: "text-slate-500"
								}`}
							>
								{sessionTimeLeft <= SESSION_WARNING_MS
									? "Session ending soon"
									: `Session: ${Math.floor(sessionTimeLeft / 60000)}:${String(
											Math.floor((sessionTimeLeft % 60000) / 1000),
										).padStart(2, "0")}`}
							</span>
						</div>
					)}
					{isSessionEnding && (
						<p className="mt-3 animate-pulse text-center text-xs font-semibold text-amber-600">
							⏰ Session time limit reached. Processing your triage...
						</p>
					)}
				</div>

				<div className="flex flex-col rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-sm">
					{isTriageComplete && !isAborted && (
						<div className="mb-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm font-semibold text-green-700">
							Chat ended. Report has been submitted to the doctor queue.
						</div>
					)}
					{isAborted && (
						<div className="mb-4 rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm font-semibold text-orange-700">
							Triage aborted: The session was closed due to invalid or
							uncooperative responses.
						</div>
					)}
					<div className="mb-3 flex items-center justify-between">
						<h3 className="font-headline text-lg font-semibold text-slate-900">
							Live Chat
						</h3>
						<span
							className={`rounded-full px-3 py-1 text-xs font-semibold ${
								isListening
									? "bg-emerald-100 text-emerald-700"
									: "bg-slate-100 text-slate-500"
							}`}
						>
							{isListening ? "● Live" : "Idle"}
						</span>
					</div>

					<div
						ref={chatLogRef}
						className="flex max-h-80 min-h-48 flex-col space-y-3 overflow-y-auto rounded-xl bg-slate-50 p-4"
					>
						{chatLog.length === 0 ? (
							<p className="py-8 text-center text-sm text-slate-400">
								Conversation with the AI assistant will appear here...
							</p>
						) : (
							chatLog.map((msg) => (
								<div
									key={msg.id}
									className={`flex ${msg.role === "user" ? "justify-end" : msg.role === "system" ? "justify-center" : "justify-start"}`}
								>
									<div
										className={`max-w-[90%] rounded-2xl px-4 py-2 text-sm leading-relaxed ${
											msg.role === "user"
												? "rounded-br-sm bg-blue-500 text-white"
												: msg.role === "system"
													? "rounded-xl border border-amber-200 bg-amber-50 text-center text-amber-700 shadow-sm"
													: "rounded-bl-sm bg-white text-slate-800 shadow-sm"
										} ${msg.isFinal ? "" : "opacity-60"}`}
									>
										{msg.text}
										{!msg.isFinal && (
											<span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-current align-text-bottom" />
										)}
									</div>
								</div>
							))
						)}
						<div ref={messagesEndRef} />
					</div>
				</div>
			</div>

			{error && (
				<div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-red-700">
					{error}
				</div>
			)}

			<div ref={reportRef} className="mt-4">
				{isGeneratingReport && (
					<div className="space-y-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
						<div className="h-8 w-1/3 animate-pulse rounded-lg bg-slate-200"></div>
						<div className="space-y-2 pt-4">
							<div className="h-4 w-full animate-pulse rounded bg-slate-100"></div>
							<div className="h-4 w-5/6 animate-pulse rounded bg-slate-100"></div>
							<div className="h-4 w-4/6 animate-pulse rounded bg-slate-100"></div>
						</div>
						<div className="pt-4">
							<div className="h-10 w-32 animate-pulse rounded-xl bg-slate-200"></div>
						</div>
					</div>
				)}

				{analysis && (
					<div
						className={`space-y-4 rounded-3xl border p-5 shadow-sm ${
							urgencyPanelStyle[analysis.urgency] || urgencyPanelStyle.LOW
						}`}
					>
						{analysis.safety_override && (
							<div className="rounded-xl border border-red-300 bg-red-100 px-4 py-3 text-sm font-semibold text-red-800">
								{analysis.safety_message ||
									"Emergency safety rule triggered. Immediate care is recommended."}
							</div>
						)}

						<div className="flex items-center justify-between gap-3">
							<h3 className="font-headline text-xl font-bold">Triage Result</h3>
							<UrgencyBadge urgency={analysis.urgency} />
						</div>

						{typeof analysis.confidence === "number" && (
							<div>
								<div className="mb-1 flex items-center justify-between">
									<p className="text-xs font-bold uppercase tracking-wide text-slate-500">
										AI Confidence
									</p>
									<span
										className={`text-sm font-bold ${confidenceTextColor(analysis.confidence)}`}
									>
										{analysis.confidence}%
									</span>
								</div>
								<div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
									<div
										className={`h-2 rounded-full transition-all duration-500 ${confidenceBarColor(analysis.confidence)}`}
										style={{ width: `${analysis.confidence}%` }}
									/>
								</div>
							</div>
						)}

						<div>
							<p className="text-xs font-bold uppercase tracking-wide text-slate-500">
								Doctor Summary
							</p>
							<p className="mt-1 text-slate-900">{analysis.summary}</p>
						</div>

						<div>
							<p className="text-xs font-bold uppercase tracking-wide text-slate-500">
								Possible Issue
							</p>
							<p className="mt-1 text-slate-800">{analysis.possible_issue}</p>
						</div>

						<div>
							<p className="text-xs font-bold uppercase tracking-wide text-slate-500">
								Scheduling Recommendation
							</p>
							<p className="mt-1 text-slate-800">{analysis.recommendation}</p>
						</div>

						{Array.isArray(analysis.urgency_reasons) &&
							analysis.urgency_reasons.length > 0 && (
								<div>
									<p className="text-xs font-bold uppercase tracking-wide text-slate-500">
										Why This Urgency
									</p>
									<ul className="mt-1 list-disc space-y-1 pl-5 text-slate-800">
										{analysis.urgency_reasons.map((reason, i) => (
											<li key={`${reason}-${i}`}>{reason}</li>
										))}
									</ul>
								</div>
							)}

						<p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
							⚠️ This tool determines appointment scheduling priority only. It
							does not provide medical diagnoses or treatment advice. A licensed
							physician must evaluate the patient.
						</p>

						<button
							onClick={deleteTriageResult}
							className="rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700"
						>
							Delete Result
						</button>
					</div>
				)}
			</div>
		</section>
	);
}

export default PatientTriage;
