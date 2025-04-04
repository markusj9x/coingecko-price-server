import { createServer, IncomingMessage, ServerResponse } from 'http';
import { parse } from 'url';
import axios from 'axios';

// Reusable function to get price data
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


// Create the HTTP server
const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
	const parsedUrl = parse(req.url || '', true); // true parses query string

	// Add a basic root handler for health checks
	if (parsedUrl.pathname === '/' && req.method === 'GET') {
		res.writeHead(200, { 'Content-Type': 'text/plain' });
		res.end('CoinGecko Price SSE Server OK');
		return;
	}

	// Handle SSE requests on the /sse path
	if (parsedUrl.pathname === '/sse' && req.method === 'GET') {
		// Set SSE headers
		res.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive',
			'Access-Control-Allow-Origin': '*', // Allow requests from any origin (adjust for production)
		});

		const tokenId = parsedUrl.query.token_id as string;

		// Send a connecting message (optional)
		res.write(`event: status\ndata: Connecting...\n\n`);

		// Fetch the price
		const result = await getCoinGeckoPrice(tokenId);

		// Send the price data or error as an SSE event
		if (result.price !== undefined) {
			const dataPayload = JSON.stringify({ token_id: tokenId, price: result.price });
			res.write(`event: price\ndata: ${dataPayload}\n\n`);
		} else {
			const errorPayload = JSON.stringify({ token_id: tokenId, error: result.error });
			res.write(`event: error\ndata: ${errorPayload}\n\n`);
		}

		// Send a closing message and end the response
		res.write(`event: status\ndata: Closing connection.\n\n`);
		res.end(); // Close the connection after sending the data

	} else {
		// Handle other paths or methods
		res.writeHead(404, { 'Content-Type': 'text/plain' });
		res.end('Not Found. Use GET /sse?token_id=... for price data.');
	}
});

// Start the server
const port = process.env.PORT || 3000; // Use environment variable for port or default to 3000
server.listen(port, () => {
	console.log(`CoinGecko Price SSE server running at http://localhost:${port}/`);
	console.log(`SSE endpoint: http://localhost:${port}/sse`);
	console.log(`Example usage: http://localhost:${port}/sse?token_id=bitcoin`);
});

// Basic error handling
server.on('error', (error) => {
	console.error('Server Error:', error);
});

// Graceful shutdown (optional but recommended)
process.on('SIGINT', () => {
	console.log('Shutting down server...');
	server.close(() => {
		console.log('Server shut down.');
		process.exit(0);
	});
});
