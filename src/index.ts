import { createServer, IncomingMessage } from 'http';
import axios from 'axios';
import { WebSocketServer, WebSocket } from 'ws';

// --- Define MCP Structures Manually (Based on JSON-RPC 2.0 and MCP conventions) ---
// Basic JSON-RPC Request/Response structures
interface JsonRpcRequest {
	jsonrpc: '2.0';
	method: string;
	params?: any;
	id: string | number | null;
}

interface JsonRpcResponse {
	jsonrpc: '2.0';
	id: string | number | null;
	result?: any;
	error?: JsonRpcError;
}

interface JsonRpcError {
	code: number;
	message: string;
	data?: any;
}

// MCP Specific structures (simplified)
interface McpToolDefinition {
	name: string;
	description?: string;
	inputSchema?: object; // JSON Schema
}

// Define Error Codes manually if not importable
enum McpErrorCode {
	ParseError = -32700,
	InvalidRequest = -32600,
	MethodNotFound = -32601,
	InvalidParams = -32602,
	InternalError = -32603,
	// Add other MCP-specific codes if needed
}

// --- CoinGecko Logic (same as before) ---
const isValidPriceArgs = (args: any): args is { token_id: string } =>
	typeof args === 'object' && args !== null && typeof args.token_id === 'string';

async function getCoinGeckoPrice(tokenId: string): Promise<{ price?: number; error?: string }> {
	if (!tokenId || typeof tokenId !== 'string') {
		return { error: 'Invalid or missing token_id parameter.' };
	}
	try {
		const axiosInstance = axios.create({
			baseURL: 'https://api.coingecko.com/api/v3',
		});
		const response = await axiosInstance.get('/simple/price', {
			params: {
				ids: tokenId,
				vs_currencies: 'usd',
			},
		});
		if (response.data && response.data[tokenId] && response.data[tokenId].usd) {
			return { price: response.data[tokenId].usd };
		} else {
			return { error: `Could not find price data for token ID: ${tokenId}` };
		}
	} catch (error) {
		let errorMessage = 'An unknown error occurred while fetching the price.';
		if (axios.isAxiosError(error)) {
			errorMessage = `CoinGecko API error: ${error.response?.data?.error || error.message}`;
		} else if (error instanceof Error) {
			errorMessage = error.message;
		}
		return { error: errorMessage };
	}
}

// --- Manual MCP Handlers ---
const coingeckoToolDefinition: McpToolDefinition = {
	name: 'get_coingecko_price',
	description: 'Get the current price of a cryptocurrency from CoinGecko.',
	inputSchema: {
		type: 'object',
		properties: {
			token_id: {
				type: 'string',
				description: "The CoinGecko ID of the token (e.g., 'bitcoin', 'ethereum').",
			},
		},
		required: ['token_id'],
	},
};

async function handleMcpRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
	const { method, params, id } = request;
	console.log(`[Manual Handler Request ${id}] Method: ${method}`);

	try {
		// --- Route MCP Methods ---
		if (method === 'listTools') {
			return {
				jsonrpc: '2.0',
				id: id,
				result: {
					tools: [coingeckoToolDefinition],
				},
			};
		} else if (method === 'callTool') {
			// Basic validation for callTool params
			if (!params || typeof params !== 'object' || typeof params.name !== 'string') {
				throw { code: McpErrorCode.InvalidParams, message: 'Invalid params for callTool' };
			}

			if (params.name === 'get_coingecko_price') {
				if (!isValidPriceArgs(params.arguments)) {
					throw { code: McpErrorCode.InvalidParams, message: 'Invalid arguments for get_coingecko_price: requires a "token_id" string.' };
				}
				const tokenId = params.arguments.token_id;
				const result = await getCoinGeckoPrice(tokenId);

				if (result.price !== undefined) {
					return {
						jsonrpc: '2.0',
						id: id,
						result: { // MCP CallToolResponse structure
							content: [{ type: 'text', text: `The current price of ${tokenId} is $${result.price} USD.` }],
						},
					};
				} else {
					// Application-level error, return as error in JSON-RPC response
					throw { code: McpErrorCode.InternalError, message: result.error || 'Failed to get price.' };
				}
			} else {
				throw { code: McpErrorCode.MethodNotFound, message: `Unknown tool: ${params.name}` };
			}
		} else {
			throw { code: McpErrorCode.MethodNotFound, message: `Unsupported method: ${method}` };
		}
	} catch (error: any) {
		console.error(`[Manual Handler Error ${id}]`, error);
		// Ensure error has code and message for JSON-RPC response
		const code = typeof error.code === 'number' ? error.code : McpErrorCode.InternalError;
		const message = typeof error.message === 'string' ? error.message : 'Internal Server Error';
		return {
			jsonrpc: '2.0',
			id: id,
			error: { code, message },
		};
	}
}

// --- HTTP and WebSocket Server Setup ---
const httpServer = createServer((req: IncomingMessage, res) => {
	// Basic HTTP server - responds 404 to non-WebSocket upgrade requests
	if (req.headers.upgrade !== 'websocket') {
		res.writeHead(404, { 'Content-Type': 'text/plain' });
		res.end('Not Found. Use WebSocket connection.');
		return;
	}
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
	console.log('[WebSocketServer] Client connected.');

	ws.on('message', async (data) => {
		console.log('[WebSocketServer] Received message:', data.toString());
		let requestId: string | number | null = null;
		try {
			const request: JsonRpcRequest = JSON.parse(data.toString());
			requestId = request.id; // Capture ID early

			// Basic validation
			if (request.jsonrpc !== '2.0' || !request.method) {
				throw { code: McpErrorCode.InvalidRequest, message: 'Invalid JSON-RPC request structure' };
			}

			// Handle the request manually
			const response = await handleMcpRequest(request);

			// Send the response back
			if (ws.readyState === WebSocket.OPEN) {
				console.log(`[WebSocketServer] Sending response ${response.id}:`, JSON.stringify(response));
				ws.send(JSON.stringify(response));
			}

		} catch (error: any) {
			console.error(`[WebSocketServer] Error processing message (request ID: ${requestId}):`, error);
			// Send JSON-RPC error response
			const code = typeof error.code === 'number' ? error.code : McpErrorCode.InternalError;
			const message = typeof error.message === 'string' ? error.message : 'Internal Server Error';
			const errorResponse: JsonRpcResponse = {
				jsonrpc: '2.0',
				id: requestId, // Use captured ID if available
				error: { code, message },
			};
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify(errorResponse));
			}
		}
	});

	ws.on('close', () => {
		console.log('[WebSocketServer] Client disconnected.');
	});

	ws.on('error', (error) => {
		console.error('[WebSocketServer] WebSocket connection error:', error);
	});
});

// Start the HTTP server (which hosts the WebSocket server)
const port = process.env.PORT || 3000;
httpServer.listen(port, () => {
	console.log(`CoinGecko Price MCP WebSocket server running on port ${port}`);
	console.log(`Connect via WebSocket at ws://localhost:${port}`); // Or wss://your-render-url
});

httpServer.on('error', (error) => {
	console.error('HTTP Server Error:', error);
});

process.on('SIGINT', () => {
	console.log('Shutting down server...');
	wss.close(() => {
		httpServer.close(() => {
			console.log('Server shut down.');
			process.exit(0);
		});
	});
});
