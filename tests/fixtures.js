const spec = {
  openapi: '3.0.3',
  info: { title: 'Pets API' },
  servers: [{ url: 'https://api.example.com/v1' }],
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets',
        responses: {
          200: {
            description: 'ok',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/Pet' } },
              },
            },
          },
        },
      },
    },
    '/pets/{petId}': {
      get: {
        parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: {
          200: {
            description: 'ok',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
          },
          404: { description: 'not found' },
        },
      },
    },
    '/health': { post: { responses: { 200: { description: 'ignored: not a GET' } } } },
  },
  components: {
    schemas: {
      Pet: {
        type: 'object',
        required: ['id', 'name'],
        properties: { id: { type: 'integer' }, name: { type: 'string' }, tag: { type: 'string', nullable: true } },
      },
    },
  },
};

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const secureHeaders = {
  'x-content-type-options': 'nosniff',
  'strict-transport-security': 'max-age=63072000',
};

module.exports = { spec, jsonResponse, secureHeaders };
