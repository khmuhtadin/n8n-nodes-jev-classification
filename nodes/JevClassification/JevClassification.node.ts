import type {
	IDataObject,
	IExecuteFunctions,
	IN8nHttpFullResponse,
	INodeExecutionData,
	INodeParameters,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import {
	jsonParse,
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	sleep,
} from 'n8n-workflow';

import type { ApiResponse, Operation, Question, Request } from './helpers';
import {
	buildQuestion,
	buildRequests,
	retryDelayMs,
	runPool,
	splitAnswers,
	toResult,
} from './helpers';

const API_URL = 'https://api.typesafe.ai/v1/systemone';

// Stringified into the `outputs` expression, so it must not use imports or closures.
const configuredOutputs = (parameters: INodeParameters) => {
	const operation = parameters.operation as string;
	if (operation === 'check') {
		return [
			{ type: 'main', displayName: 'Yes' },
			{ type: 'main', displayName: 'No' },
		];
	}
	if (operation !== 'classify') {
		return [{ type: 'main', displayName: 'Result' }];
	}
	const collection = (parameters.categories as IDataObject) || {};
	const categories = (collection.categories as IDataObject[]) || [];
	const outputs = categories.map((entry) => ({
		type: 'main',
		displayName: entry.category as string,
	}));
	const options = (parameters.options as IDataObject) || {};
	if (options.uncertainHandling !== 'best') {
		outputs.push({ type: 'main', displayName: 'Needs Review' });
	}
	return outputs;
};

interface Options {
	model?: string;
	modelId?: string;
	confidenceThreshold?: number;
	uncertainHandling?: 'review' | 'best';
	itemsPerRequest?: number;
	concurrency?: number;
	maxRetries?: number;
	timeout?: number;
	outputField?: string;
	includeInput?: boolean;
}

interface Settings {
	model: string;
	confidenceThreshold: number;
	uncertainHandling: 'review' | 'best';
	itemsPerRequest: number;
	concurrency: number;
	maxRetries: number;
	timeout: number;
	outputField: string;
	includeInput: boolean;
	continueOnFail: boolean;
}

type Outcome = { response: ApiResponse } | { error: string };

function parseJson(
	ctx: IExecuteFunctions,
	value: unknown,
	label: string,
	itemIndex: number,
): unknown {
	if (typeof value !== 'string') return value;
	try {
		return jsonParse(value);
	} catch {
		throw new NodeOperationError(ctx.getNode(), `${label} is not valid JSON`, { itemIndex });
	}
}

function readState(ctx: IExecuteFunctions, item: INodeExecutionData, itemIndex: number): unknown {
	const inputType = ctx.getNodeParameter('inputType', itemIndex) as string;
	if (inputType === 'text') return ctx.getNodeParameter('text', itemIndex) as string;
	if (inputType === 'json') {
		return parseJson(ctx, ctx.getNodeParameter('json', itemIndex), 'JSON', itemIndex);
	}
	return item.json;
}

function readQuestions(
	ctx: IExecuteFunctions,
	operation: Operation,
	categories: Array<{ category: string; description: string }>,
	levels: string[],
	itemIndex: number,
): Record<string, Question> {
	if (operation === 'ask') {
		const questions = parseJson(
			ctx,
			ctx.getNodeParameter('questions', itemIndex),
			'Questions',
			itemIndex,
		);
		if (typeof questions !== 'object' || questions === null || Array.isArray(questions)) {
			throw new NodeOperationError(ctx.getNode(), 'Questions must be a JSON object', { itemIndex });
		}
		return questions as Record<string, Question>;
	}
	const instructions = ctx.getNodeParameter('instructions', itemIndex) as string;
	if (instructions.trim() === '') {
		throw new NodeOperationError(ctx.getNode(), 'Instructions cannot be empty', { itemIndex });
	}
	const yesMeans =
		operation === 'check' ? (ctx.getNodeParameter('yesMeans', itemIndex) as string) : '';
	const noMeans =
		operation === 'check' ? (ctx.getNodeParameter('noMeans', itemIndex) as string) : '';
	return { q: buildQuestion(operation, { instructions, categories, levels, yesMeans, noMeans }) };
}

function apiError(ctx: IExecuteFunctions, response: IN8nHttpFullResponse, itemIndex: number) {
	const status = response.statusCode;
	const body = response.body as JsonObject;
	if (status === 401) {
		return new NodeOperationError(
			ctx.getNode(),
			'The TypeSafe API key was rejected. Check the credential.',
			{ itemIndex },
		);
	}
	if (status === 422) {
		const detail = body.detail as Array<{ loc: string[]; msg: string }> | string;
		const message = Array.isArray(detail)
			? detail.map((d) => `${d.loc.join('.')}: ${d.msg}`).join('; ')
			: JSON.stringify(detail);
		return new NodeOperationError(ctx.getNode(), `TypeSafe rejected the request: ${message}`, {
			itemIndex,
		});
	}
	if (status === 429 || status === 529) {
		return new NodeApiError(ctx.getNode(), body, {
			itemIndex,
			httpCode: String(status),
			message: 'TypeSafe is rate limiting or overloaded. Lower Parallel Requests or retry later.',
		});
	}
	return new NodeApiError(ctx.getNode(), body, { itemIndex, httpCode: String(status) });
}

function fail(settings: Settings, error: NodeOperationError | NodeApiError): Outcome {
	if (settings.continueOnFail) return { error: error.message };
	throw error;
}

async function sendRequest(
	ctx: IExecuteFunctions,
	request: Request,
	settings: Settings,
): Promise<Outcome> {
	const itemIndex = request.itemIndexes[0];
	const body = { state: request.state, model: settings.model, questions: request.questions };
	for (let attempt = 0; ; attempt++) {
		let response: IN8nHttpFullResponse;
		try {
			response = await ctx.helpers.httpRequestWithAuthentication.call(ctx, 'jevClassificationApi', {
				method: 'POST',
				url: API_URL,
				body,
				json: true,
				timeout: settings.timeout,
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
			});
		} catch (error) {
			return fail(settings, new NodeApiError(ctx.getNode(), error as JsonObject, { itemIndex }));
		}
		if (response.statusCode === 200) return { response: response.body as ApiResponse };
		const retryable = response.statusCode === 429 || response.statusCode >= 500;
		if (retryable && attempt < settings.maxRetries) {
			await sleep(retryDelayMs(attempt, response.headers['retry-after'] as string | undefined));
			continue;
		}
		return fail(settings, apiError(ctx, response, itemIndex));
	}
}

export class JevClassification implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Jev Classification',
		name: 'jevClassification',
		icon: { light: 'file:../../icons/jev.svg', dark: 'file:../../icons/jev.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Classify, score and check text with Jev by TypeSafe AI',
		defaults: {
			name: 'Jev Classification',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: `={{(${configuredOutputs})($parameter)}}`,
		usableAsTool: true,
		credentials: [
			{
				name: 'jevClassificationApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Classify',
						value: 'classify',
						description: 'Pick one category and route the item to that output',
						action: 'Classify text into categories',
					},
					{
						name: 'Score',
						value: 'score',
						description: 'Rate the text on an ordered scale you define',
						action: 'Score text against levels',
					},
					{
						name: 'Check',
						value: 'check',
						description: 'Yes/no question, routes to Yes or No output',
						action: 'Check whether a statement is true',
					},
					{
						name: 'Ask Questions',
						value: 'ask',
						description: 'Send any mix of questions as JSON, get all answers',
						action: 'Ask custom questions',
					},
				],
				default: 'classify',
			},
			{
				displayName: 'Input',
				name: 'inputType',
				type: 'options',
				options: [
					{ name: 'Text', value: 'text' },
					{ name: 'JSON', value: 'json' },
					{ name: 'Whole Input Item', value: 'item' },
				],
				default: 'text',
				description: 'What to send to Jev as the state to judge',
			},
			{
				displayName: 'Text',
				name: 'text',
				type: 'string',
				typeOptions: { rows: 3 },
				required: true,
				default: '',
				placeholder: 'e.g. {{ $json.message }}',
				description: 'The text Jev should judge',
				displayOptions: { show: { inputType: ['text'] } },
			},
			{
				displayName: 'JSON',
				name: 'json',
				type: 'json',
				required: true,
				default: '{}',
				description: 'A JSON value Jev should judge',
				displayOptions: { show: { inputType: ['json'] } },
			},
			{
				displayName: 'Instructions',
				name: 'instructions',
				type: 'string',
				typeOptions: { rows: 2 },
				required: true,
				default: '',
				placeholder: 'e.g. Which team should handle this ticket?',
				description: 'The question Jev answers about the input',
				displayOptions: { show: { operation: ['classify'] } },
			},
			{
				displayName: 'Instructions',
				name: 'instructions',
				type: 'string',
				typeOptions: { rows: 2 },
				required: true,
				default: '',
				placeholder: 'e.g. How frustrated is the customer?',
				description: 'The question Jev answers about the input',
				displayOptions: { show: { operation: ['score'] } },
			},
			{
				displayName: 'Instructions',
				name: 'instructions',
				type: 'string',
				typeOptions: { rows: 2 },
				required: true,
				default: '',
				placeholder: 'e.g. Does the message ask for a refund?',
				description: 'The statement Jev checks against the input',
				displayOptions: { show: { operation: ['check'] } },
			},
			{
				displayName: 'Categories',
				name: 'categories',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				placeholder: 'Add Category',
				default: {},
				description: 'Each category becomes an output. Add at least two.',
				displayOptions: { show: { operation: ['classify'] } },
				options: [
					{
						name: 'categories',
						displayName: 'Category',
						values: [
							{
								displayName: 'Category',
								name: 'category',
								type: 'string',
								noDataExpression: true,
								required: true,
								default: '',
								placeholder: 'e.g. Billing',
								description: 'Category name, used as the output label',
							},
							{
								displayName: 'Description',
								name: 'description',
								type: 'string',
								default: '',
								placeholder: 'e.g. Invoices, refunds and payment issues',
								description: 'What belongs in this category',
							},
						],
					},
				],
			},
			{
				displayName: 'Levels',
				name: 'levels',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				placeholder: 'Add Level',
				default: {},
				description: 'Ordered from lowest to highest. Add between two and ten levels.',
				displayOptions: { show: { operation: ['score'] } },
				options: [
					{
						name: 'levels',
						displayName: 'Level',
						values: [
							{
								displayName: 'Level',
								name: 'level',
								type: 'string',
								required: true,
								default: '',
								placeholder: 'e.g. Calm, no sign of frustration',
								description: 'What this level means',
							},
						],
					},
				],
			},
			{
				displayName: 'Yes Means',
				name: 'yesMeans',
				type: 'string',
				default: '',
				placeholder: 'e.g. The customer explicitly asks for money back',
				description: 'What counts as a yes',
				displayOptions: { show: { operation: ['check'] } },
			},
			{
				displayName: 'No Means',
				name: 'noMeans',
				type: 'string',
				default: '',
				placeholder: 'e.g. The customer only asks a question about pricing',
				description: 'What counts as a no',
				displayOptions: { show: { operation: ['check'] } },
			},
			{
				displayName: 'Questions',
				name: 'questions',
				type: 'json',
				required: true,
				default: '{}',
				placeholder: 'e.g. { "urgent": { "type": "noul", "instructions": "Is this urgent?" } }',
				description: 'Map of question ID to question, exactly as in the TypeSafe API reference',
				displayOptions: { show: { operation: ['ask'] } },
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				options: [
					{
						displayName: 'Confidence Threshold',
						name: 'confidenceThreshold',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
						default: 0.5,
						description:
							'Classify and Score mark the item as needing review below this confidence. Check answers Yes when the probability is at or above it.',
					},
					{
						displayName: 'Include Input Fields',
						name: 'includeInput',
						type: 'boolean',
						default: true,
						description: 'Whether to copy the input item fields into the output item',
					},
					{
						displayName: 'Items Per Request',
						name: 'itemsPerRequest',
						type: 'number',
						typeOptions: { minValue: 1, maxValue: 50 },
						default: 1,
						description:
							'How many items to pack into one API request. Faster and cheaper, but large states reduce accuracy, and the packed state plus the longest question must fit in 32k tokens.',
					},
					{
						displayName: 'Max Retries',
						name: 'maxRetries',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 10 },
						default: 3,
						description: 'How many times to retry a request after a 429, 529 or 5xx response',
					},
					{
						displayName: 'Model',
						name: 'model',
						type: 'options',
						options: [
							{ name: 'Custom', value: 'custom' },
							{ name: 'Jev Latest', value: 'jev-latest' },
							{ name: 'Jev Preview', value: 'jev-preview' },
						],
						default: 'jev-latest',
						description: 'Which Jev model answers the questions',
					},
					{
						displayName: 'Model ID',
						name: 'modelId',
						type: 'string',
						default: '',
						placeholder: 'e.g. jev-1.13.0',
						description: 'Exact model name, see GET https://api.typesafe.ai/v1/models',
						displayOptions: { show: { model: ['custom'] } },
					},
					{
						displayName: 'Output Field',
						name: 'outputField',
						type: 'string',
						default: 'jev',
						description: 'Name of the field that receives the result',
					},
					{
						displayName: 'Parallel Requests',
						name: 'concurrency',
						type: 'number',
						typeOptions: { minValue: 1, maxValue: 20 },
						default: 4,
						description: 'How many API requests to run at the same time',
					},
					{
						displayName: 'Timeout',
						name: 'timeout',
						type: 'number',
						typeOptions: { minValue: 1000 },
						default: 60000,
						description: 'Time in milliseconds to wait for one API request',
					},
					{
						displayName: 'When Uncertain',
						name: 'uncertainHandling',
						type: 'options',
						options: [
							{
								name: 'Send to Best Category Anyway',
								value: 'best',
								description:
									'Route to the most probable category and mark the item as needing review',
							},
							{
								name: 'Send to Needs Review Output',
								value: 'review',
								description: 'Route to a separate Needs Review output',
							},
						],
						default: 'review',
						description: 'Where to send items whose confidence is below the threshold',
						displayOptions: { show: { '/operation': ['classify'] } },
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const operation = this.getNodeParameter('operation', 0) as Operation;
		const options = this.getNodeParameter('options', 0, {}) as Options;
		const settings: Settings = {
			model: options.model === 'custom' ? (options.modelId ?? '') : (options.model ?? 'jev-latest'),
			confidenceThreshold: options.confidenceThreshold ?? 0.5,
			uncertainHandling: options.uncertainHandling ?? 'review',
			itemsPerRequest: options.itemsPerRequest ?? 1,
			concurrency: options.concurrency ?? 4,
			maxRetries: options.maxRetries ?? 3,
			timeout: options.timeout ?? 60000,
			outputField: options.outputField ?? 'jev',
			includeInput: options.includeInput ?? true,
			continueOnFail: this.continueOnFail(),
		};

		let categories: Array<{ category: string; description: string }> = [];
		let levels: string[] = [];
		if (operation === 'classify') {
			const collection = this.getNodeParameter('categories', 0, {}) as {
				categories?: Array<{ category: string; description: string }>;
			};
			categories = collection.categories ?? [];
			if (categories.length < 2) {
				throw new NodeOperationError(this.getNode(), 'Add at least two categories', {
					itemIndex: 0,
				});
			}
		}
		if (operation === 'score') {
			const collection = this.getNodeParameter('levels', 0, {}) as {
				levels?: Array<{ level: string }>;
			};
			levels = (collection.levels ?? []).map((entry) => entry.level);
			if (levels.length < 2 || levels.length > 10) {
				throw new NodeOperationError(this.getNode(), 'Add between two and ten levels', {
					itemIndex: 0,
				});
			}
		}

		const states = items.map((item, i) => readState(this, item, i));
		const questions = items.map((_, i) => readQuestions(this, operation, categories, levels, i));
		const requests = buildRequests(states, questions, settings.itemsPerRequest);
		const outcomes = await runPool(
			requests.map((request) => () => sendRequest(this, request, settings)),
			settings.concurrency,
		);

		let outputCount = 1;
		if (operation === 'check') outputCount = 2;
		if (operation === 'classify') {
			outputCount = categories.length + (settings.uncertainHandling === 'review' ? 1 : 0);
		}
		const outputs: INodeExecutionData[][] = Array.from({ length: outputCount }, () => []);
		const categoryNames = categories.map((entry) => entry.category);

		requests.forEach((request, r) => {
			const outcome = outcomes[r];
			if ('error' in outcome) {
				for (const itemIndex of request.itemIndexes) {
					outputs[0].push({ json: { error: outcome.error }, pairedItem: { item: itemIndex } });
				}
				return;
			}
			const perItem = splitAnswers(outcome.response, request);
			request.itemIndexes.forEach((itemIndex, position) => {
				const { result, outputIndex } = toResult(operation, perItem[position], {
					categories: categoryNames,
					confidenceThreshold: settings.confidenceThreshold,
					uncertainHandling: settings.uncertainHandling,
					model: outcome.response.model,
					usage: outcome.response.usage,
				});
				const json: IDataObject = settings.includeInput ? { ...items[itemIndex].json } : {};
				json[settings.outputField] = result as IDataObject;
				outputs[outputIndex].push({ json, pairedItem: { item: itemIndex } });
			});
		});

		return outputs;
	}
}
