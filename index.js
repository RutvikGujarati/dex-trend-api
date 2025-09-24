import express from 'express';
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';
import {
    Sdk,
    MakerTraits,
    Address,
    randBigInt,
    FetchProviderConnector,
} from "@1inch/limit-order-sdk";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.ONEINCH_API_KEY;

// Middleware
app.use(express.json());
app.use(cors({
    origin: [
        'http://localhost:3000',
        'http://localhost:5173',
        'http://localhost:3001',
        'https://dex-trend.com',
        'https://www.dex-trend.com'
    ],
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));



// 1inch quote proxy endpoint
app.post('/api/1inch-quote', async (req, res) => {
    const { src, dst, amount } = req.body;

    // Validate required parameters
    if (!src || !dst || !amount) {
        return res.status(400).json({
            error: 'Missing required parameters',
            required: ['src', 'dst', 'amount']
        });
    }

    console.log(`Getting quote: ${amount} of ${src} -> ${dst}`);

    const url = "https://api.1inch.dev/swap/v6.1/137/quote";
    const config = {
        headers: {
            Authorization: `Bearer ${API_KEY}`,
            'Accept': 'application/json',
        },
        params: {
            src,
            dst,
            amount,
        },
        paramsSerializer: {
            indexes: null,
        },
        timeout: 10000, // 10 second timeout
    };

    try {
        const response = await axios.get(url, config);
        console.log('1inch API response received');
        console.log('Response data:', response.data);
        res.json(response.data);
    } catch (error) {
        console.error('1inch API error:', {
            status: error.response?.status,
            statusText: error.response?.statusText,
            data: error.response?.data,
            message: error.message
        });

        // Return more specific error information
        if (error.response) {
            // The request was made and the server responded with a status code
            res.status(error.response.status).json({
                error: 'API request failed',
                status: error.response.status,
                details: error.response.data || error.message
            });
        } else if (error.request) {
            // The request was made but no response was received
            res.status(503).json({
                error: 'No response from 1inch API',
                details: 'Service temporarily unavailable'
            });
        } else {
            // Something happened in setting up the request
            res.status(500).json({
                error: 'Request setup failed',
                details: error.message
            });
        }
    }
});
const orderStore = new Map();

const generateOrderId = () => Date.now().toString() + Math.random().toString(36).substr(2, 9);

app.post('/api/1inch-create-order-complete', async (req, res) => {
    const { makerToken, takerToken, makingAmount, takingAmount, maker } = req.body;

    try {
        // Initialize SDK on server
        const sdk = new Sdk({
            authKey: API_KEY,
            networkId: 137,
            httpConnector: new FetchProviderConnector(),
        });

        const expiresIn = 86400n; // 24 hours
        const expiration = BigInt(Math.floor(Date.now() / 1000)) + expiresIn;
        const UINT_40_MAX = (1n << 40n) - 1n;
        const nonce = randBigInt(UINT_40_MAX);

        const makerTraits = MakerTraits.default()
            .withExpiration(expiration)
            .withNonce(nonce)
            .allowMultipleFills()    // Allow multiple fills
            .allowPartialFills();    // Allow partial fills

        const order = await sdk.createOrder(
            {
                makerAsset: new Address(makerToken),
                takerAsset: new Address(takerToken),
                makingAmount: BigInt(makingAmount),
                takingAmount: BigInt(takingAmount),
                maker: new Address(maker),
            },
            makerTraits
        );

        const orderId = generateOrderId();
        orderStore.set(orderId, order);

        // Clean up old orders after 1 hour
        setTimeout(() => {
            orderStore.delete(orderId);
        }, 60 * 60 * 1000);

        // Return order data for client to sign
        const typedData = order.getTypedData(137);
        const orderHash = order.getOrderHash(137);

        console.log('Order created and stored:', {
            orderId,
            orderHash,
            storeSize: orderStore.size
        });

        res.json({
            success: true,
            orderId,
            orderHash,
            typedData
        });

    } catch (error) {
        console.error('Server order creation failed:', error);
        res.status(500).json({
            error: 'Failed to create order',
            details: error.message
        });
    }
});

app.post('/api/1inch-submit-order', async (req, res) => {
    console.log('=== SUBMIT ORDER DEBUG ===');
    console.log('Request body:', JSON.stringify(req.body, null, 2));

    const { orderId, signature } = req.body;

    if (!orderId || !signature) {
        console.log('Missing parameters:', {
            hasOrderId: !!orderId,
            hasSignature: !!signature
        });
        return res.status(400).json({
            error: 'Missing required parameters',
            required: ['orderId', 'signature'],
            received: Object.keys(req.body)
        });
    }

    try {
        const sdk = new Sdk({
            authKey: API_KEY,
            networkId: 137,
            httpConnector: new FetchProviderConnector(),
        });

        // Retrieve the stored order
        const order = orderStore.get(orderId);

        if (!order) {
            console.error('Order not found for ID:', orderId);
            console.log('Available order IDs:', Array.from(orderStore.keys()));
            return res.status(400).json({
                error: 'Order not found',
                message: 'Order may have expired or invalid order ID',
                orderId
            });
        }

        console.log('Retrieved order for ID:', orderId);
        console.log('Order hash:', order.getOrderHash(137));
        console.log('Submitting with signature:', signature);

        const result = await sdk.submitOrder(order, signature);

        // Clean up the stored order after successful submission
        orderStore.delete(orderId);

        console.log('Order submitted successfully:', result);
        res.json({
            success: true,
            result: result
        });

    } catch (error) {
        console.error('=== ORDER SUBMISSION ERROR ===');
        console.error('Error name:', error.name);
        console.error('Error message:', error.message);

        if (error.response) {
            console.error('HTTP status:', error.response.status);
            console.error('Response data:', JSON.stringify(error.response.data, null, 2));
        }

        res.status(500).json({
            error: 'Failed to submit order',
            details: error.message,
            statusCode: error.response?.status,
            responseData: error.response?.data
        });
    }
});
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({
        error: 'Internal server error',
        details: error.message
    });
});

app.use((req, res) => {
    res.status(404).json({
        error: 'Endpoint not found',
        path: req.path,
        method: req.method,
        available: [
            'POST /api/1inch-quote',
            'GET /api/1inch-tokens'
        ]
    });
});

app.listen(PORT, () => {
    console.log(`🚀 1inch Proxy Server running on port ${PORT}`);
    console.log(`🔑 Using API Key: ${API_KEY.substring(0, 8)}...`);
});

process.on('SIGTERM', () => {
    console.log('SIGTERM received. Shutting down gracefully...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('\nSIGINT received. Shutting down gracefully...');
    process.exit(0);
});