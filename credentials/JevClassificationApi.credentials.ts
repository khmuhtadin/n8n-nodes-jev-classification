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
			description: 'API key from the TypeSafe AI dashboard',
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

	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://api.typesafe.ai',
			url: '/v1/models',
			method: 'GET',
		},
	};
}
