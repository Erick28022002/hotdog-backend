const express = require('express');
const { SquareClient, SquareEnvironment } = require('square');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(cors({
  origin: [
    'https://erick28022002.github.io',
    'https://Erick28022002.github.io',
    'https://hotdogmaracay.com',
    'http://hotdogmaracay.com',
    'http://localhost:8080',
    'http://192.168.1.113:8080'
  ]
}));

const squareClient = new SquareClient({
  token: process.env.SQUARE_ACCESS_TOKEN || 'EAAAl1FkkZdprJZ4zVL-sHWvMbPOV4xWgqOLxFfAW6aRf_1hzoFQF0_Aq1yOVPfo',
  environment: SquareEnvironment.Sandbox
});

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://ckzvjudhpbhzisrrhozk.supabase.co',
  process.env.SUPABASE_KEY || 'sb_publishable_5cEosCpGfTIM-culYQ1ofA_xggsaIBc'
);

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/api/pay', async (req, res) => {
  try {
    const { sourceId, amount, items, customer, orderType, location, notes } = req.body;
    if (!sourceId || !amount) return res.status(400).json({ success: false, error: 'Faltan datos' });

    const amountCents = Math.round(parseFloat(amount) * 100);

    const response = await squareClient.payments.create({
      sourceId,
      idempotencyKey: crypto.randomUUID(),
      amountMoney: { amount: BigInt(amountCents), currency: 'USD' },
      locationId: process.env.SQUARE_LOCATION_ID || 'LT874YA53K13J'
    });

    const payment = response?.payment || response?.result?.payment || response;
    const paymentId = payment?.id?.toString() || '';
    const receiptUrl = payment?.receiptUrl?.toString() || '';

    // Guardar pedido en Supabase
    await supabase.from('web_orders').insert({
      customer_name: customer?.name || '',
      customer_phone: customer?.phone || '',
      customer_email: customer?.email || '',
      items: items || [],
      total: parseFloat(amount),
      payment_id: paymentId,
      receipt_url: receiptUrl,
      order_type: orderType || 'pickup',
      location: location || '',
      notes: notes || '',
      status: 'pending'
    });

    res.json({ success: true, paymentId, receiptUrl });
  } catch (err) {
    const errMsg = err?.errors?.[0]?.detail || err?.message || JSON.stringify(err);
    console.error('Error Square:', errMsg);
    res.status(400).json({ success: false, message: errMsg });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Hotdog backend en puerto ${PORT}`));
