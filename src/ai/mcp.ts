export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (arguments_: Record<string, unknown>) => Promise<unknown>;
};

export type McpResponse = {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: { code: number; message: string };
};

export function createMcpServer(tools: McpTool[]) {
  return async function handleMcpMessage(message: unknown): Promise<McpResponse> {
    if (!message || typeof message !== 'object') {
      return { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid request' } };
    }
    const request = message as Record<string, unknown>;
    const id = typeof request.id === 'string' || typeof request.id === 'number' ? request.id : undefined;
    const method = String(request.method ?? '');
    const params = request.params && typeof request.params === 'object' ? request.params as Record<string, unknown> : {};

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'saint-jude-ai', version: '1.0.0' },
        },
      };
    }

    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };

    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) } };
    }

    if (method === 'tools/call' && typeof params.name === 'string') {
      const arguments_ = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? params.arguments as Record<string, unknown>
        : {};
      const tool = tools.find((candidate) => candidate.name === params.name);
      if (!tool) return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${params.name}` } };
      try {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(await tool.execute(arguments_)) }] } };
      } catch (error) {
        return { jsonrpc: '2.0', id, error: { code: -32603, message: error instanceof Error ? error.message : 'Tool error' } };
      }
    }

    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  };
}
