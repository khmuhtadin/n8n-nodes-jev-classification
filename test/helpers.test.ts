import { sleep } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import type { ApiResponse, Question, QuestionParams } from '../nodes/JevClassification/helpers';
import {
	buildQuestion,
	buildRequests,
	parseCategories,
	retryDelayMs,
	runPool,
	splitAnswers,
	toResult,
} from '../nodes/JevClassification/helpers';

const params: QuestionParams = {
	instructions: 'Which team?',
	categories: [
		{ category: 'Billing', description: 'Money' },
		{ category: 'Tech', description: '' },
	],
	levels: ['Low', 'High'],
	yesMeans: '',
	noMeans: '',
};

const resultOptions = {
	categories: ['Billing', 'Tech'],
	confidenceThreshold: 0.5,
	uncertainHandling: 'review' as const,
	model: 'jev-1.13.0',
	usage: { input_tokens: 10, output_tokens: 0 },
};

describe('buildQuestion', () => {
	it('builds a choice question with null for empty descriptions', () => {
		expect(buildQuestion('classify', params)).toEqual({
			type: 'choice',
			instructions: 'Which team?',
			criteria: { Billing: 'Money', Tech: null },
		});
	});

	it('builds a score question from levels', () => {
		expect(buildQuestion('score', params)).toEqual({
			type: 'score',
			instructions: 'Which team?',
			criteria: ['Low', 'High'],
		});
	});

	it('builds a noul question without criteria when yes/no are empty', () => {
		expect(buildQuestion('check', params)).toEqual({ type: 'noul', instructions: 'Which team?' });
	});

	it('builds a noul question with criteria', () => {
		expect(
			buildQuestion('check', { ...params, yesMeans: 'Asks for money', noMeans: 'Just asks' }),
		).toEqual({
			type: 'noul',
			instructions: 'Which team?',
			criteria: { true: 'Asks for money', false: 'Just asks' },
		});
	});
});

describe('buildRequests and splitAnswers', () => {
	const question: Question = { type: 'noul', instructions: 'Urgent?' };
	const states = ['a', 'b', 'c', 'd', 'e'];
	const questions = states.map(() => ({ q: question }));

	it('sends one plain request per item when itemsPerRequest is 1', () => {
		const requests = buildRequests(states, questions, 1);
		expect(requests).toHaveLength(5);
		expect(requests[2]).toEqual({
			state: 'c',
			questions: { q: question },
			itemIndexes: [2],
			packed: false,
		});
		const response: ApiResponse = {
			model: 'm',
			answers: { q: { type: 'noul', noul: 0.9 } },
			usage: { input_tokens: 1, output_tokens: 0 },
		};
		expect(splitAnswers(response, requests[2])).toEqual([{ q: { type: 'noul', noul: 0.9 } }]);
	});

	it('packs items into state.items and prefixes question keys and instructions', () => {
		const requests = buildRequests(states, questions, 2);
		expect(requests).toHaveLength(3);
		expect(requests[0].state).toEqual({ items: ['a', 'b'] });
		expect(requests[0].itemIndexes).toEqual([0, 1]);
		expect(requests[0].questions).toEqual({
			i0_q: { type: 'noul', instructions: 'About `items[0]` only: Urgent?' },
			i1_q: { type: 'noul', instructions: 'About `items[1]` only: Urgent?' },
		});
		expect(requests[2].state).toEqual({ items: ['e'] });
		expect(requests[2].itemIndexes).toEqual([4]);
		expect(requests[2].packed).toBe(true);
		expect(Object.keys(requests[2].questions)).toEqual(['i0_q']);
	});

	it('demuxes prefixed answers back to items', () => {
		const requests = buildRequests(states, questions, 2);
		const response: ApiResponse = {
			model: 'm',
			answers: { i1_q: { type: 'noul', noul: 0.2 }, i0_q: { type: 'noul', noul: 0.8 } },
			usage: { input_tokens: 1, output_tokens: 0 },
		};
		expect(splitAnswers(response, requests[0])).toEqual([
			{ q: { type: 'noul', noul: 0.8 } },
			{ q: { type: 'noul', noul: 0.2 } },
		]);
		const single: ApiResponse = { ...response, answers: { i0_q: { type: 'noul', noul: 0.6 } } };
		expect(splitAnswers(single, requests[2])).toEqual([{ q: { type: 'noul', noul: 0.6 } }]);
	});

	it('stringifies structured instructions when scoping them', () => {
		const requests = buildRequests(
			['a', 'b'],
			[{ x: { type: 'noul', instructions: { ask: 'Urgent?' } } }, { x: question }],
			2,
		);
		expect(requests[0].questions.i0_x.instructions).toBe(
			'About `items[0]` only: {"ask":"Urgent?"}',
		);
	});
});

describe('toResult', () => {
	it('routes a confident classification to its category output', () => {
		const shaped = toResult(
			'classify',
			{
				q: {
					type: 'choice',
					choice: 'Tech',
					probabilities: { Billing: 0.1, Tech: 0.9 },
					confidence: 0.9,
				},
			},
			resultOptions,
		);
		expect(shaped).toEqual({
			result: {
				category: 'Tech',
				confidence: 0.9,
				needsReview: false,
				probabilities: { Billing: 0.1, Tech: 0.9 },
				model: 'jev-1.13.0',
			},
			outputIndex: 1,
		});
	});

	it('routes an uncertain classification to Needs Review', () => {
		const answers = {
			q: {
				type: 'choice' as const,
				choice: 'Tech',
				probabilities: { Billing: 0.45, Tech: 0.55 },
				confidence: 0.55,
			},
		};
		expect(
			toResult('classify', answers, { ...resultOptions, confidenceThreshold: 0.7 }).outputIndex,
		).toBe(2);
		expect(
			toResult('classify', answers, {
				...resultOptions,
				confidenceThreshold: 0.7,
				uncertainHandling: 'best',
			}),
		).toMatchObject({
			result: { needsReview: true },
			outputIndex: 1,
		});
	});

	it('shapes a score with the most probable level text', () => {
		const shaped = toResult(
			'score',
			{
				q: {
					type: 'score',
					score: 1,
					legend: { '0': 'Low', '1': 'High' },
					probabilities: { '0': 0.3, '1': 0.7 },
					confidence: 0.7,
				},
			},
			resultOptions,
		);
		expect(shaped).toEqual({
			result: {
				score: 1,
				level: 'High',
				confidence: 0.7,
				needsReview: false,
				probabilities: { '0': 0.3, '1': 0.7 },
				legend: { '0': 'Low', '1': 'High' },
				model: 'jev-1.13.0',
			},
			outputIndex: 0,
		});
	});

	it('answers yes at or above the threshold and routes to output 0, otherwise 1', () => {
		expect(toResult('check', { q: { type: 'noul', noul: 0.5 } }, resultOptions)).toEqual({
			result: { answer: true, probability: 0.5, model: 'jev-1.13.0' },
			outputIndex: 0,
		});
		expect(toResult('check', { q: { type: 'noul', noul: 0.49 } }, resultOptions)).toEqual({
			result: { answer: false, probability: 0.49, model: 'jev-1.13.0' },
			outputIndex: 1,
		});
	});

	it('passes raw answers through for ask', () => {
		const answers = { urgent: { type: 'noul' as const, noul: 0.3 } };
		expect(toResult('ask', answers, resultOptions)).toEqual({
			result: { answers, usage: { input_tokens: 10, output_tokens: 0 }, model: 'jev-1.13.0' },
			outputIndex: 0,
		});
	});
});

describe('retryDelayMs', () => {
	it('grows exponentially from 500 ms and caps at 8 s', () => {
		expect(retryDelayMs(0)).toBe(500);
		expect(retryDelayMs(1)).toBe(1000);
		expect(retryDelayMs(3)).toBe(4000);
		expect(retryDelayMs(10)).toBe(8000);
	});

	it('caps a huge retry-after header at 60 s', () => {
		expect(retryDelayMs(0, '3600')).toBe(60000);
	});

	it('honors a retry-after header in seconds', () => {
		expect(retryDelayMs(0, '2')).toBe(2000);
		expect(retryDelayMs(5, 'soon')).toBe(8000);
	});
});

describe('runPool', () => {
	it('returns results in task order and never exceeds the concurrency', async () => {
		let running = 0;
		let peak = 0;
		const tasks = [30, 5, 20, 1, 10].map((ms, i) => async () => {
			running++;
			peak = Math.max(peak, running);
			await sleep(ms);
			running--;
			return i;
		});
		expect(await runPool(tasks, 2)).toEqual([0, 1, 2, 3, 4]);
		expect(peak).toBe(2);
	});

	it('handles an empty task list', async () => {
		expect(await runPool([], 4)).toEqual([]);
	});
});

describe('parseCategories', () => {
	it('splits a comma-separated string and trims names', () => {
		expect(parseCategories(' billing, technical ,sales')).toEqual([
			{ category: 'billing', description: '' },
			{ category: 'technical', description: '' },
			{ category: 'sales', description: '' },
		]);
	});

	it('accepts a JSON array string and a real array', () => {
		const expected = [
			{ category: 'a', description: '' },
			{ category: 'b', description: '' },
		];
		expect(parseCategories('["a", "b"]')).toEqual(expected);
		expect(parseCategories(['a', 'b'])).toEqual(expected);
	});

	it('accepts a JSON object of name to description, null meaning no description', () => {
		const expected = [
			{ category: 'billing', description: 'Invoices and refunds' },
			{ category: 'other', description: '' },
		];
		expect(parseCategories('{"billing": "Invoices and refunds", "other": null}')).toEqual(expected);
		expect(parseCategories({ billing: 'Invoices and refunds', other: null })).toEqual(expected);
	});

	it('rejects values that are not a list or an object', () => {
		expect(() => parseCategories(42)).toThrow('Categories must be');
		expect(() => parseCategories('{not json')).toThrow();
	});
});
