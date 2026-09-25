import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class JevClassificationApi implements ICredentialType {
	name = 'jevClassificationApi';

	displayName = 'Jev (TypeSafe) API';

	icon: Icon = { light: 'file:../icons/jev.svg', dark: 'file:../icons/jev.dark.svg' };

	documentationUrl = 'https://github.com/khmuhtadin/n8n-nodes-jev-classification#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'API key from TypeSafe (console.typesafe.ai) or from a gateway such as OpenRouter',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.typesafe.ai',
			required: true,
			placeholder: 'e.g. https://openrouter.ai/api',
			description:
				'Where /v1/systemone is served. TypeSafe: https://api.typesafe.ai. OpenRouter: https://openrouter.ai/api. Vercel AI Gateway: https://ai-gateway.vercel.sh/typesafe.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	// One tiny real request: gateways such as OpenRouter serve /v1/models without a key,
	// so only /v1/systemone proves the key works. Costs about 270 input tokens.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl.replace(/\\/+$/, "")}}',
			url: '/v1/systemone',
			method: 'POST',
			body: {
				state: 'ping',
				model: 'jev-latest',
				questions: { ok: { type: 'noul', instructions: 'Is this a test?' } },
			},
		},
	};
}
