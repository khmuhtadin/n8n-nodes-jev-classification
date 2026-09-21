export type Operation = 'classify' | 'score' | 'check' | 'ask';

export type Instructions = string | object;

export interface ChoiceQuestion {
	type: 'choice';
	instructions: Instructions;
	criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
	type: 'score';
	instructions: Instructions;
	criteria: string[];
}

export interface NoulQuestion {
	type: 'noul';
	instructions: Instructions;
	criteria?: { true?: string; false?: string };
}

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

export interface ChoiceAnswer {
	type: 'choice';
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
}

export interface ScoreAnswer {
	type: 'score';
	score: number;
	legend: Record<string, string>;
	probabilities: Record<string, number>;
	confidence: number;
}

export interface NoulAnswer {
	type: 'noul';
	noul: number;
}

export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export interface Usage {
	input_tokens: number;
	output_tokens: number;
}

export interface ApiResponse {
	model: string;
	answers: Record<string, Answer>;
	usage: Usage;
}

export interface Category {
	category: string;
	description: string;
}

export interface QuestionParams {
	instructions: string;
	categories: Category[];
	levels: string[];
	yesMeans: string;
	noMeans: string;
}

export interface Request {
	state: unknown;
	questions: Record<string, Question>;
	itemIndexes: number[];
	packed: boolean;
}

export interface ResultOptions {
	categories: string[];
	confidenceThreshold: number;
	uncertainHandling: 'review' | 'best';
	model: string;
	usage: Usage;
}

export interface ShapedResult {
	result: Record<string, unknown>;
	outputIndex: number;
}

export function buildQuestion(
	op: 'classify' | 'score' | 'check',
	params: QuestionParams,
): Question {
	if (op === 'classify') {
		const criteria: Record<string, string | null> = {};
		for (const { category, description } of params.categories) {
			criteria[category] = description === '' ? null : description;
		}
		return { type: 'choice', instructions: params.instructions, criteria };
	}
	if (op === 'score') {
		return { type: 'score', instructions: params.instructions, criteria: params.levels };
	}
	const question: NoulQuestion = { type: 'noul', instructions: params.instructions };
	if (params.yesMeans !== '' || params.noMeans !== '') {
		question.criteria = {};
		if (params.yesMeans !== '') question.criteria.true = params.yesMeans;
		if (params.noMeans !== '') question.criteria.false = params.noMeans;
	}
	return question;
}

// Accepts "a, b, c", ["a", "b"] or { "a": "what a means", "b": null }.
export function parseCategories(value: unknown): Category[] {
	let parsed = value;
	if (typeof value === 'string') {
		const text = value.trim();
		parsed = text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text.split(',');
	}
	if (Array.isArray(parsed)) {
		return parsed.map((name) => ({ category: String(name).trim(), description: '' }));
	}
	if (typeof parsed === 'object' && parsed !== null) {
		return Object.entries(parsed).map(([category, description]) => ({
			category: category.trim(),
			description: description === null || description === undefined ? '' : String(description),
		}));
	}
	throw new Error('Categories must be a comma-separated list, a JSON array or a JSON object');
}

function scopeInstructions(instructions: Instructions, position: number): string {
	const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions);
	return `About \`items[${position}]\` only: ${text}`;
}

export function buildRequests(
	states: unknown[],
	questionsPerItem: Array<Record<string, Question>>,
	itemsPerRequest: number,
): Request[] {
	if (itemsPerRequest === 1) {
		return states.map((state, i) => ({
			state,
			questions: questionsPerItem[i],
			itemIndexes: [i],
			packed: false,
		}));
	}
	const requests: Request[] = [];
	for (let start = 0; start < states.length; start += itemsPerRequest) {
		const itemIndexes: number[] = [];
		const questions: Record<string, Question> = {};
		for (let i = start; i < Math.min(start + itemsPerRequest, states.length); i++) {
			const position = i - start;
			itemIndexes.push(i);
			for (const [key, question] of Object.entries(questionsPerItem[i])) {
				questions[`i${position}_${key}`] = {
					...question,
					instructions: scopeInstructions(question.instructions, position),
				};
			}
		}
		requests.push({
			state: { items: states.slice(start, start + itemsPerRequest) },
			questions,
			itemIndexes,
			packed: true,
		});
	}
	return requests;
}

export function splitAnswers(
	response: ApiResponse,
	request: Request,
): Array<Record<string, Answer>> {
	if (!request.packed) return [response.answers];
	return request.itemIndexes.map((_, position) => {
		const prefix = `i${position}_`;
		const answers: Record<string, Answer> = {};
		for (const [key, answer] of Object.entries(response.answers)) {
			if (key.startsWith(prefix)) answers[key.slice(prefix.length)] = answer;
		}
		return answers;
	});
}

function mostProbable(probabilities: Record<string, number>): string {
	let best = '';
	let bestValue = -1;
	for (const [key, value] of Object.entries(probabilities)) {
		if (value > bestValue) {
			best = key;
			bestValue = value;
		}
	}
	return best;
}

export function toResult(
	op: Operation,
	answers: Record<string, Answer>,
	options: ResultOptions,
): ShapedResult {
	if (op === 'classify') {
		const answer = answers.q as ChoiceAnswer;
		const needsReview = answer.confidence < options.confidenceThreshold;
		const result = {
			category: answer.choice,
			confidence: answer.confidence,
			needsReview,
			probabilities: answer.probabilities,
			model: options.model,
		};
		if (needsReview && options.uncertainHandling === 'review') {
			return { result, outputIndex: options.categories.length };
		}
		return { result, outputIndex: options.categories.indexOf(answer.choice) };
	}
	if (op === 'score') {
		const answer = answers.q as ScoreAnswer;
		return {
			result: {
				score: answer.score,
				level: answer.legend[mostProbable(answer.probabilities)],
				confidence: answer.confidence,
				needsReview: answer.confidence < options.confidenceThreshold,
				probabilities: answer.probabilities,
				legend: answer.legend,
				model: options.model,
			},
			outputIndex: 0,
		};
	}
	if (op === 'check') {
		const answer = answers.q as NoulAnswer;
		const yes = answer.noul >= options.confidenceThreshold;
		return {
			result: { answer: yes, probability: answer.noul, model: options.model },
			outputIndex: yes ? 0 : 1,
		};
	}
	return { result: { answers, usage: options.usage, model: options.model }, outputIndex: 0 };
}

export function retryDelayMs(attempt: number, retryAfterHeader?: string): number {
	const seconds = Number(retryAfterHeader);
	if (retryAfterHeader !== undefined && Number.isFinite(seconds)) {
		return Math.min(seconds * 1000, 60000);
	}
	return Math.min(500 * 2 ** attempt, 8000);
}

export async function runPool<T>(
	tasks: Array<() => Promise<T>>,
	concurrency: number,
): Promise<T[]> {
	const results: T[] = new Array(tasks.length);
	let next = 0;
	const worker = async () => {
		while (next < tasks.length) {
			const index = next++;
			results[index] = await tasks[index]();
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
	return results;
}
