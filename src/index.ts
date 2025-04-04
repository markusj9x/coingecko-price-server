import express, { Request, Response } from 'express';
import axios from 'axios';
import http from 'http';

// --- Define MCP Structures Manually (Based on JSON-RPC 2.0 and MCP conventions) ---
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

interface McpToolDefinition {
	name: string;
	description?: string;
	inputSchema?: object; // JSON Schema
}

enum McpErrorCode {
	ParseError = -32700,
	InvalidRequest = -32600,
	MethodNotFound = -32601,
	InvalidParams = -32602,
	InternalError = -32603,
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

// Store the active SSE response stream (simple approach for single client)
// For multiple clients, you'd need a map (e.g., using a session ID from POST /messages)
let activeSseResponse: Response | null = null;
let activeSseClientId: string | number | null = null; // Track ID for potential async responses

// Function to send data over the active SSE connection
function sendSseMessage(res: Response | null, id: string | number | null, eventName: string, data: any) {
	if (res && !res.writableEnded) {
		const payload = JSON.stringify(data);
		console.log(`[SSE Send ${id}] Event: ${eventName}, Data: ${payload}`);
		// Note: Sending request ID in SSE 'id' field might not be standard MCP,
		// but helps correlate responses if needed. Standard SSE just uses 'id' for stream position.
		res.write(`id: ${id || Date.now()}\n`);
		res.write(`event: ${eventName}\n`);
		res.write(`data: ${payload}\n\n`);
	} else {
		console.warn(`[SSE Send ${id}] Attempted to send message but no active/writable SSE connection.`);
	}
}

// Function to send JSON-RPC responses via SSE
function sendSseJsonResponse(res: Response | null, response: JsonRpcResponse) {
	// According to MCP spec, responses/notifications are sent via the SSE stream
	sendSseMessage(res, response.id, 'mcp_message', response); // Use a generic event like 'mcp_message'
}


async function handleMcpRequestViaPost(request: JsonRpcRequest): Promise<JsonRpcResponse> {
	const { method, params, id } = request;
	console.log(`[Manual Handler POST ${id}] Method: ${method}`);

	try {
		if (method === 'listTools') {
			return {
				jsonrpc: '2.0',
				id: id,
				result: { tools: [coingeckoToolDefinition] },
			};
		} else if (method === 'callTool') {
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
						result: { content: [{ type: 'text', text: `The current price of ${tokenId} is $${result.price} USD.` }] },
					};
				} else {
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
		const code = typeof error.code === 'number' ? error.code : McpErrorCode.InternalError;
		const message = typeof error.message === 'string' ? error.message : 'Internal Server Error';
		return {
			jsonrpc: '2.0',
			id: id,
			error: { code, message },
		};
	}
}

// --- Express App Setup ---
const app = express();
app.use(express.json()); // Middleware to parse JSON POST bodies

// 1. SSE Endpoint (GET /sse)
app.get('/sse', async (req: Request, res: Response) => {
	console.log('[Express] Received GET /sse request');
	if (activeSseResponse) {
		console.warn('[Express] Overwriting existing SSE connection. Server only supports one client currently.');
		activeSseResponse.end(); // Close previous connection
	}

	// Set SSE headers
	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		'Connection': 'keep-alive',
		'Access-Control-Allow-Origin': '*', // Adjust for production
	});

	// Send a connection confirmation message (optional)
	sendSseMessage(res, null, 'mcp_status', { status: 'connected' });

	// Store the response object for sending messages later
	activeSseResponse = res;
	activeSseClientId = null; // Reset client ID for this connection

	console.log('[Express] SSE connection established');

	// Keep connection open - handle client disconnect
	req.on('close', () => {
		console.log('[Express] Client disconnected from /sse');
		if (activeSseResponse === res) {
			activeSseResponse = null; // Clear the active response stream
			activeSseClientId = null;
		}
	});
});

// 2. Message Endpoint (POST /messages)
app.post('/messages', async (req: Request, res: Response) => {
	console.log('[Express] Received POST /messages request:', req.body);
	let requestId: string | number | null = null;
	try {
		const request: JsonRpcRequest = req.body;
		requestId = request.id; // Capture ID

		// Basic validation
		if (request.jsonrpc !== '2.0' || !request.method) {
			throw { code: McpErrorCode.InvalidRequest, message: 'Invalid JSON-RPC request structure' };
		}

		// Process the request
		const response = await handleMcpRequestViaPost(request);

		// Send the response back via the active SSE stream
		sendSseJsonResponse(activeSseResponse, response);

		// Send a 202 Accepted response to the POST request itself
		// (The actual result comes via SSE)
		res.status(202).send({ status: 'Request received, response sent via SSE.' });

	} catch (error: any) {
		console.error(`[Express POST /messages Error ${requestId}]`, error);
		const code = typeof error.code === 'number' ? error.code : McpErrorCode.InternalError;
		const message = typeof error.message === 'string' ? error.message : 'Internal Server Error';
		// Send error back to the POST request originator
		res.status(500).json({
			jsonrpc: '2.0',
			id: requestId,
			error: { code, message },
		});
		// Optionally also send error via SSE if a connection exists
		if (activeSseResponse) {
			sendSseJsonResponse(activeSseResponse, {
				jsonrpc: '2.0',
				id: requestId,
				error: { code, message },
			});
		}
	}
});

// Basic root handler
app.get('/', (req, res) => {
	res.status(200).send('CoinGecko Price MCP Server (Manual SSE Transport) is running. Connect via GET /sse and POST /messages.');
});

// --- Start Server ---
const port = process.env.PORT || 3000;
const httpServer = http.createServer(app);

httpServer.listen(port, () => {
	console.log(`CoinGecko Price MCP SSE server running on port ${port}`);
	console.log(`SSE Endpoint: http://localhost:${port}/sse`);
	console.log(`Message Endpoint: http://localhost:${port}/messages`);
});

httpServer.on('error', (error) => {
	console.error('HTTP Server Error:', error);
});

process.on('SIGINT', () => {
	console.log('Shutting down server...');
	if (activeSseResponse) {
		activeSseResponse.end(); // Close active SSE connection
	}
	httpServer.close(() => {
		console.log('Server shut down.');
		process.exit(0);
	});
});
