import mongoose from "mongoose";

const triageCaseSchema = new mongoose.Schema({
	caseId: {
		type: String,
		required: true,
		unique: true,
	},
	patientTempId: {
		type: String,
		required: true,
	},
	urgency: {
		type: String,
		enum: ["HIGH", "MEDIUM", "LOW"],
		required: true,
	},
	confidence: {
		type: Number,
		required: true,
		min: 0,
		max: 100,
	},
	summary: {
		type: String,
		required: true,
	},
	possibleIssue: {
		type: String,
		required: true,
	},
	recommendation: {
		type: String,
		required: true,
	},
	urgencyReasons: {
		type: [String],
		default: [],
	},
	chatHistory: {
		type: [{ role: String, text: String }],
		default: [],
	},
	status: {
		type: String,
		default: "queued_for_doctor",
	},
	createdAt: {
		type: Date,
		default: Date.now,
	},
});

const TriageCase = mongoose.model("TriageCase", triageCaseSchema);

export default TriageCase;
