import { useEffect, useState } from "react";
import UrgencyBadge from "./components/UrgencyBadge";

const API_BASE_URL =
	import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";

const urgencyColors = {
	HIGH: "border-red-300 bg-red-50",
	MEDIUM: "border-orange-300 bg-orange-50",
	LOW: "border-green-300 bg-green-50",
};

function DoctorDashboard() {
	const [cases, setCases] = useState([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");

	useEffect(() => {
		const fetchQueue = async () => {
			try {
				setLoading(true);
				const res = await fetch(`${API_BASE_URL}/api/triage/queue`);
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const data = await res.json();
				setCases(data);
			} catch (err) {
				console.error("[DoctorDashboard] Fetch error:", err);
				setError(err.message || "Failed to load doctor queue");
			} finally {
				setLoading(false);
			}
		};

		fetchQueue();
	}, []);

	const formatDate = (iso) => {
		try {
			return new Date(iso).toLocaleString("en-PH", {
				year: "numeric",
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			});
		} catch {
			return iso;
		}
	};

	return (
		<section className="space-y-4">
			<div className="rounded-3xl border border-slate-200 bg-white/85 p-5 shadow-sm">
				<h2 className="font-headline text-2xl font-bold text-slate-900">
					Doctor's View
				</h2>
				<p className="text-slate-600">
					Top 10 most recent triage cases, sorted by submission date.
				</p>
			</div>

			{loading && (
				<div className="rounded-2xl border border-slate-200 bg-white/60 p-8 text-center text-slate-500">
					Loading cases...
				</div>
			)}

			{error && (
				<div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-red-700">
					{error}
				</div>
			)}

			{!loading && !error && cases.length === 0 && (
				<div className="rounded-2xl border border-dashed border-slate-300 bg-white/60 p-8 text-center text-slate-500">
					No triage cases yet. Start a triage session from the patient page.
				</div>
			)}

			{!loading && cases.length > 0 && (
				<div className="grid gap-4 md:grid-cols-2">
					{cases.map((item) => (
						<article
							key={item._id || item.caseId}
							className={`rounded-2xl border-2 p-4 shadow-sm ${
								urgencyColors[item.urgency] || urgencyColors.LOW
							}`}
						>
							<div className="mb-3 flex items-center justify-between gap-3">
								<span className="font-mono text-xs font-semibold text-slate-500">
									{item.caseId}
								</span>
								<UrgencyBadge urgency={item.urgency} />
							</div>

							<p className="mb-2 text-sm leading-relaxed text-slate-900">
								{item.summary}
							</p>

							<div className="mb-1 text-sm text-slate-700">
								<span className="font-semibold">Recommendation:</span>{" "}
								{item.recommendation}
							</div>

							<div className="mt-3 text-xs text-slate-400">
								Submitted: {formatDate(item.createdAt)}
							</div>
						</article>
					))}
				</div>
			)}
		</section>
	);
}

export default DoctorDashboard;
