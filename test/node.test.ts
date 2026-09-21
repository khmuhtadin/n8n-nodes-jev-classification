import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { describe, expect, it, vi } from 'vitest';

import type { Answer, Question } from '../nodes/JevClassification/helpers';
import { JevClassification } from '../nodes/JevClassification/JevClassification.node';

type Params = Record<string, unknown>;
type RequestMock = ReturnType<typeof vi.fn>;

function makeContext(
	items: INodeExecutionData[],
	params: Params,
	request: RequestMock,
	continueOnFail = false,
) {
	const ctx = {
		getInputData: () => items,
		getNodeParameter: (name: string, itemIndex: number, fallback?: unknown) => {
			const value = name.split('.').reduce<unknown>((o, key) => (o as Params)?.[key], params);
			if (typeof value === 'function') return value(itemIndex);
			return value ?? fallback;
		},
		getNode: () => ({
			id: '1',
			name: 'Jev Classification',
			type: 'jevClassification',
			typeVersion: 1,
			position: [0, 0],
			parameters: {},
		}),
		continueOnFail: () => continueOnFail,
		helpers: { httpRequestWithAuthentication: request },
	};
	return ctx as unknown as IExecuteFunctions;
}

function run(
	items: INodeExecutionData[],
	params: Params,
	request: RequestMock,
	continueOnFail = false,
) {
	return new JevClassification().execute.call(makeContext(items, params, request, continueOnFail));
}

const ok = (answers: Record<string, Answer>) => ({
	statusCode: 200,
	headers: {},
	body: { model: 'jev-1.13.0', answers, usage: { input_tokens: 12, output_tokens: 0 } },
});

// Answers every question in a request, looking up the right item of a packed state.
function server(answerFor: (state: unknown, question: Question) => Answer) {
	return vi.fn(
		async (
			_credential: string,
			opts: { body: { state: unknown; questions: Record<string, Question> } },
		) => {
			const { state, questions } = opts.body;
			const answers: Record<string, Answer> = {};
			for (const [key, question] of Object.entries(questions)) {
				const packed = key.match(/^i(\d+)_/);
				const itemState = packed ? (state as { items: unknown[] }).items[Number(packed[1])] : state;
				answers[key] = answerFor(itemState, question);
			}
			return ok(answers);
		},
	);
}

const tickets = [
	{ json: { id: 1, message: 'Refund my invoice' } },
	{ json: { id: 2, message: 'App crashes on login' } },
	{ json: { id: 3, message: 'Hello?' } },
];

const classifyParams: Params = {
	operation: 'classify',
	inputType: 'text',
	text: (i: number) => tickets[i].json.message,
	instructions: 'Which team should handle this ticket?',
	categories: {
		categories: [
			{ category: 'Billing', description: '' },
			{ category: 'Tech', description: '' },
		],
	},
	options: {},
};

const choiceFor = (state: unknown): Answer => {
	const text = state as string;
	if (text.includes('invoice'))
		return {
			type: 'choice',
			choice: 'Billing',
			probabilities: { Billing: 0.9, Tech: 0.1 },
			confidence: 0.9,
		};
	if (text.includes('crash'))
		return {
			type: 'choice',
			choice: 'Tech',
			probabilities: { Billing: 0.2, Tech: 0.8 },
			confidence: 0.8,
		};
	return {
		type: 'choice',
		choice: 'Tech',
		probabilities: { Billing: 0.45, Tech: 0.55 },
		confidence: 0.3,
	};
};

describe('classify', () => {
	it('routes items to category outputs and Needs Review', async () => {
		const request = server(choiceFor);
		const outputs = await run(tickets, classifyParams, request);
		expect(request).toHaveBeenCalledTimes(3);
		expect(outputs).toHaveLength(3);
		expect(outputs[0]).toEqual([
			{
				json: {
					id: 1,
					message: 'Refund my invoice',
					jev: {
						category: 'Billing',
						confidence: 0.9,
						needsReview: false,
						probabilities: { Billing: 0.9, Tech: 0.1 },
						model: 'jev-1.13.0',
					},
				},
				pairedItem: { item: 0 },
			},
		]);
		expect(outputs[1][0].pairedItem).toEqual({ item: 1 });
		expect(outputs[2][0]).toMatchObject({
			json: { id: 3, jev: { category: 'Tech', needsReview: true } },
			pairedItem: { item: 2 },
		});
	});

	it('sends the classify request body the API expects', async () => {
		const request = server(choiceFor);
		await run(tickets, classifyParams, request);
		expect(request.mock.calls[0][1]).toMatchObject({
			method: 'POST',
			url: 'https://api.typesafe.ai/v1/systemone',
			json: true,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			timeout: 60000,
			body: {
				state: 'Refund my invoice',
				model: 'jev-latest',
				questions: {
					q: {
						type: 'choice',
						instructions: 'Which team should handle this ticket?',
						criteria: { Billing: null, Tech: null },
					},
				},
			},
		});
	});

	it('sends uncertain items to the best category when configured', async () => {
		const outputs = await run(
			tickets,
			{ ...classifyParams, options: { uncertainHandling: 'best' } },
			server(choiceFor),
		);
		expect(outputs).toHaveLength(2);
		expect(outputs[1].map((item) => item.pairedItem)).toEqual([{ item: 1 }, { item: 2 }]);
		expect(outputs[1][1].json.jev).toMatchObject({ needsReview: true });
	});

	it('honors output field and include input options', async () => {
		const outputs = await run(
			tickets,
			{ ...classifyParams, options: { outputField: 'result', includeInput: false } },
			server(choiceFor),
		);
		expect(Object.keys(outputs[0][0].json)).toEqual(['result']);
	});

	it('rejects duplicate or empty category names before any request', async () => {
		const request = server(choiceFor);
		const duplicate = {
			...classifyParams,
			categories: {
				categories: [
					{ category: 'Billing', description: '' },
					{ category: 'Billing', description: '' },
				],
			},
		};
		await expect(run(tickets, duplicate, request)).rejects.toThrow(
			'Category names must be unique and not empty',
		);
		const empty = {
			...classifyParams,
			categories: {
				categories: [
					{ category: 'Billing', description: '' },
					{ category: ' ', description: '' },
				],
			},
		};
		await expect(run(tickets, empty, request)).rejects.toThrow(
			'Category names must be unique and not empty',
		);
		expect(request).not.toHaveBeenCalled();
	});

	it('fails clearly when the API answers with a choice outside the categories', async () => {
		const request = server(() => ({
			type: 'choice',
			choice: 'billing',
			probabilities: { billing: 1 },
			confidence: 1,
		}));
		await expect(run(tickets, classifyParams, request)).rejects.toThrow(
			'Jev answered "billing", which is not one of the categories',
		);
	});

	it('passes binary data through to the output item', async () => {
		const withBinary = [{ ...tickets[0], binary: { data: { data: '', mimeType: 'text/plain' } } }];
		const outputs = await run(withBinary, classifyParams, server(choiceFor));
		expect(outputs[0][0].binary).toEqual({ data: { data: '', mimeType: 'text/plain' } });
	});

	it('rejects fewer than two categories before any request', async () => {
		const request = server(choiceFor);
		const params = {
			...classifyParams,
			categories: { categories: [{ category: 'Billing', description: '' }] },
		};
		await expect(run(tickets, params, request)).rejects.toThrow('Add at least two categories');
		expect(request).not.toHaveBeenCalled();
	});
});

describe('classify with dynamic categories', () => {
	const dynamicParams: Params = {
		...classifyParams,
		categoriesSource: 'dynamic',
		categories: undefined,
	};

	it('reads categories per item and uses a single output', async () => {
		const request = server(choiceFor);
		const outputs = await run(
			tickets,
			{
				...dynamicParams,
				dynamicCategories: (i: number) =>
					i === 0 ? 'Billing, Tech' : '{"Billing": "Money", "Tech": "Bugs"}',
			},
			request,
		);
		expect(outputs).toHaveLength(1);
		expect(outputs[0].map((item) => item.pairedItem)).toEqual([
			{ item: 0 },
			{ item: 1 },
			{ item: 2 },
		]);
		expect(outputs[0][0].json.jev).toMatchObject({ category: 'Billing', needsReview: false });
		expect(outputs[0][2].json.jev).toMatchObject({ category: 'Tech', needsReview: true });
		expect(request.mock.calls[0][1].body.questions.q.criteria).toEqual({
			Billing: null,
			Tech: null,
		});
		expect(request.mock.calls[1][1].body.questions.q.criteria).toEqual({
			Billing: 'Money',
			Tech: 'Bugs',
		});
	});

	it('rejects unreadable or too few dynamic categories before any request', async () => {
		const request = server(choiceFor);
		await expect(
			run(tickets, { ...dynamicParams, dynamicCategories: '{bad json' }, request),
		).rejects.toThrow('Categories could not be read');
		await expect(
			run(tickets, { ...dynamicParams, dynamicCategories: 'only-one' }, request),
		).rejects.toThrow('Add at least two categories');
		expect(request).not.toHaveBeenCalled();
	});

	it('does not fail when the answer is outside the dynamic categories', async () => {
		const request = server(() => ({
			type: 'choice',
			choice: 'billing',
			probabilities: { billing: 1 },
			confidence: 1,
		}));
		const outputs = await run(
			tickets,
			{ ...dynamicParams, dynamicCategories: 'Billing, Tech' },
			request,
		);
		expect(outputs[0]).toHaveLength(3);
		expect(outputs[0][0].json.jev).toMatchObject({ category: 'billing' });
	});
});

describe('check', () => {
	it('routes Yes to output 0 and No to output 1', async () => {
		const request = server((state) => ({
			type: 'noul',
			noul: (state as string).includes('Refund') ? 0.95 : 0.05,
		}));
		const outputs = await run(
			tickets,
			{
				...classifyParams,
				operation: 'check',
				instructions: 'Asks for a refund?',
				yesMeans: 'Wants money back',
				noMeans: '',
			},
			request,
		);
		expect(outputs).toHaveLength(2);
		expect(outputs[0]).toEqual([
			{
				json: {
					id: 1,
					message: 'Refund my invoice',
					jev: { answer: true, probability: 0.95, model: 'jev-1.13.0' },
				},
				pairedItem: { item: 0 },
			},
		]);
		expect(outputs[1].map((item) => item.pairedItem)).toEqual([{ item: 1 }, { item: 2 }]);
		expect(request.mock.calls[0][1].body.questions.q).toEqual({
			type: 'noul',
			instructions: 'Asks for a refund?',
			criteria: { true: 'Wants money back' },
		});
	});
});

describe('score', () => {
	it('shapes the score with the level text', async () => {
		const request = server(() => ({
			type: 'score',
			score: 2,
			legend: { '0': 'Calm', '1': 'Annoyed', '2': 'Furious' },
			probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 },
			confidence: 0.7,
		}));
		const params = {
			...classifyParams,
			operation: 'score',
			instructions: 'How frustrated is the customer?',
			levels: { levels: [{ level: 'Calm' }, { level: 'Annoyed' }, { level: 'Furious' }] },
		};
		const outputs = await run(tickets.slice(0, 1), params, request);
		expect(outputs).toHaveLength(1);
		expect(outputs[0][0].json.jev).toEqual({
			score: 2,
			level: 'Furious',
			confidence: 0.7,
			needsReview: false,
			probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 },
			legend: { '0': 'Calm', '1': 'Annoyed', '2': 'Furious' },
			model: 'jev-1.13.0',
		});
		expect(request.mock.calls[0][1].body.questions.q.criteria).toEqual([
			'Calm',
			'Annoyed',
			'Furious',
		]);
	});
});

describe('ask', () => {
	it('passes custom questions through and returns raw answers with usage', async () => {
		const request = server((_state, question) =>
			question.type === 'noul'
				? { type: 'noul', noul: 0.42 }
				: { type: 'choice', choice: 'en', probabilities: { en: 1 }, confidence: 1 },
		);
		const params = {
			operation: 'ask',
			inputType: 'item',
			questions:
				'{"urgent":{"type":"noul","instructions":"Urgent?"},"lang":{"type":"choice","instructions":"Language?","criteria":{"en":null,"de":null}}}',
			options: {},
		};
		const outputs = await run(tickets.slice(0, 1), params, request);
		expect(request.mock.calls[0][1].body.state).toEqual({ id: 1, message: 'Refund my invoice' });
		expect(outputs[0][0].json.jev).toEqual({
			answers: {
				urgent: { type: 'noul', noul: 0.42 },
				lang: { type: 'choice', choice: 'en', probabilities: { en: 1 }, confidence: 1 },
			},
			usage: { input_tokens: 12, output_tokens: 0 },
			model: 'jev-1.13.0',
		});
	});

	it('rejects invalid questions JSON before any request', async () => {
		const request = server(() => ({ type: 'noul', noul: 1 }));
		await expect(
			run(
				tickets,
				{ operation: 'ask', inputType: 'item', questions: '{oops', options: {} },
				request,
			),
		).rejects.toThrow('Questions is not valid JSON');
		expect(request).not.toHaveBeenCalled();
	});
});

describe('batching', () => {
	it('packs 7 items into 3 requests and demuxes answers to the right items', async () => {
		const items = Array.from({ length: 7 }, (_, i) => ({
			json: { n: i, message: i % 2 === 0 ? 'invoice' : 'crash' },
		}));
		const request = server(choiceFor);
		const params = {
			...classifyParams,
			text: (i: number) => items[i].json.message,
			options: { itemsPerRequest: 3, concurrency: 2 },
		};
		const outputs = await run(items, params, request);
		expect(request).toHaveBeenCalledTimes(3);
		const bodies = request.mock.calls.map((call) => call[1].body);
		expect(bodies.map((body) => body.state.items.length)).toEqual([3, 3, 1]);
		expect(Object.keys(bodies[0].questions)).toEqual(['i0_q', 'i1_q', 'i2_q']);
		expect(bodies[0].questions.i2_q.instructions).toBe(
			'About `items[2]` only: Which team should handle this ticket?',
		);
		expect(outputs[0].map((item) => item.json.n)).toEqual([0, 2, 4, 6]);
		expect(outputs[1].map((item) => item.json.n)).toEqual([1, 3, 5]);
		expect(
			outputs[0].every((item) => (item.json.jev as { category: string }).category === 'Billing'),
		).toBe(true);
		expect(outputs[2]).toEqual([]);
	});
});

describe('errors', () => {
	it('retries on 429 and then succeeds', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({
				statusCode: 429,
				headers: { 'retry-after': '0' },
				body: { detail: 'slow down' },
			})
			.mockResolvedValueOnce(ok({ q: choiceFor('invoice') }));
		const outputs = await run(tickets.slice(0, 1), classifyParams, request);
		expect(request).toHaveBeenCalledTimes(2);
		expect(outputs[0][0].json.jev).toMatchObject({ category: 'Billing' });
	});

	it('gives up after max retries with a rate limit message', async () => {
		const request = vi.fn().mockResolvedValue({
			statusCode: 529,
			headers: { 'retry-after': '0' },
			body: { detail: 'overloaded' },
		});
		await expect(
			run(tickets.slice(0, 1), { ...classifyParams, options: { maxRetries: 2 } }, request),
		).rejects.toThrow(
			'TypeSafe is rate limiting or overloaded. Lower Parallel Requests or retry later.',
		);
		expect(request).toHaveBeenCalledTimes(3);
	});

	it('explains a rejected API key', async () => {
		const request = vi.fn().mockResolvedValue({
			statusCode: 401,
			headers: {},
			body: { detail: { error_type: 'authentication_error', message: 'bad key' } },
		});
		await expect(run(tickets.slice(0, 1), classifyParams, request)).rejects.toThrow(
			'The TypeSafe API key was rejected. Check the credential.',
		);
	});

	it('surfaces the 422 detail', async () => {
		const request = vi.fn().mockResolvedValue({
			statusCode: 422,
			headers: {},
			body: {
				detail: [
					{ type: 'missing', loc: ['body', 'questions'], msg: 'Field required', input: null },
				],
			},
		});
		await expect(run(tickets.slice(0, 1), classifyParams, request)).rejects.toThrow(
			'TypeSafe rejected the request: body.questions: Field required',
		);
	});

	it('puts failed items on output 0 when continueOnFail is on', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({ statusCode: 500, headers: {}, body: { detail: 'boom' } })
			.mockResolvedValueOnce(ok({ q: choiceFor('crash') }));
		const outputs = await run(
			tickets.slice(0, 2),
			{ ...classifyParams, options: { maxRetries: 0 } },
			request,
			true,
		);
		expect(outputs[0]).toHaveLength(1);
		expect(outputs[0][0].pairedItem).toEqual({ item: 0 });
		expect(typeof outputs[0][0].json.error).toBe('string');
		expect(outputs[1][0]).toMatchObject({
			json: { id: 2, jev: { category: 'Tech' } },
			pairedItem: { item: 1 },
		});
	});
});
