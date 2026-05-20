const express = require('express');
const { SquareClient, SquareEnvironment } = require('square');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const ALLOWED_ORIGINS = [
  'https://erick28022002.github.io',
  'https://Erick28022002.github.io',
  'https://hotdogmaracay.com',
  'http://hotdogmaracay.com',
  'http://localhost:8080',
  'http://192.168.1.113:8080'
];

const app = express();

// CORS manual — primer middleware, siempre se ejecuta incluso en errores
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

const LOCATION_ID = process.env.SQUARE_LOCATION_ID;

const squareClient = new SquareClient({
  token: process.env.SQUARE_ACCESS_TOKEN,
  environment: process.env.SQUARE_ENV === 'production' ? SquareEnvironment.Production : SquareEnvironment.Sandbox
});

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://ckzvjudhpbhzisrrhozk.supabase.co',
  process.env.SUPABASE_KEY || 'sb_publishable_5cEosCpGfTIM-culYQ1ofA_xggsaIBc'
);

app.get('/health', (req, res) => res.json({ ok: true, version: 4 }));

app.post('/api/pay', async (req, res) => {
  try {
    const { sourceId, amount, items, customer, orderType, location, notes } = req.body;
    if (!sourceId || !amount) return res.status(400).json({ success: false, error: 'Faltan datos' });

    const amountCents = Math.round(parseFloat(amount) * 100);

    const orderResponse = await squareClient.orders.create({
      order: {
        locationId: LOCATION_ID,
        referenceId: 'web-order',
        lineItems: (items || []).map(item => ({
          name: item.name,
          quantity: String(item.qty || 1),
          basePriceMoney: {
            amount: BigInt(Math.round(parseFloat(item.price || 0) * 100)),
            currency: 'USD'
          }
        }))
      },
      idempotencyKey: crypto.randomUUID()
    });

    const order = orderResponse?.order || orderResponse?.result?.order;
    const orderId = order?.id;
    // Usar el total calculado por Square para evitar mismatch con impuestos
    const orderTotal = order?.totalMoney?.amount ?? BigInt(amountCents);

    const payResponse = await squareClient.payments.create({
      sourceId,
      idempotencyKey: crypto.randomUUID(),
      amountMoney: { amount: orderTotal, currency: 'USD' },
      locationId: LOCATION_ID,
      orderId,
      note: `${customer?.name || ''} | ${orderType || 'pickup'} | ${location || ''} | ${notes || ''}`
    });

    const payment = payResponse?.payment || payResponse?.result?.payment || payResponse;
    const paymentId = payment?.id?.toString() || '';
    const receiptUrl = payment?.receiptUrl?.toString() || '';

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
    console.error('Error en /api/pay:', errMsg);
    res.status(400).json({ success: false, message: errMsg });
  }
});

// Webhook de Square — recibe eventos del POS y los manda al KDS via Supabase
app.post('/webhook/square', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const rawBody = req.body.toString('utf8');
    const sigKey  = process.env.SQUARE_WEBHOOK_KEY;

    if (sigKey) {
      const signature  = req.headers['x-square-hmacsha256-signature'];
      const webhookUrl = 'https://hotdog-backend.vercel.app/webhook/square';
      const expected   = crypto.createHmac('sha256', sigKey).update(webhookUrl + rawBody).digest('base64');
      if (signature !== expected) return res.status(403).json({ error: 'Invalid signature' });
    }

    const event = JSON.parse(rawBody);

    // Pedido creado en POS — aparece en KDS inmediatamente sin necesidad de pago
    if (event.type === 'order.created') {
      const orderId = event.data?.object?.order_created?.order_id;
      if (!orderId) return res.json({ ok: true });

      let lineItems = [], locationName = '';
      try {
        const orderResp = await squareClient.orders.retrieve(orderId);
        const sqOrder   = orderResp?.order || orderResp?.result?.order;

        // Ignorar pedidos creados desde la web (para no duplicar)
        if (sqOrder?.referenceId === 'web-order') return res.json({ ok: true });

        locationName = sqOrder?.locationId || '';
        lineItems = (sqOrder?.lineItems || []).map(li => ({
          name:  li.name,
          qty:   parseInt(li.quantity) || 1,
          price: li.basePriceMoney ? Number(li.basePriceMoney.amount) / 100 : 0
        }));
      } catch (e) {
        console.error('Error fetching order:', e.message);
      }

      await supabase.from('web_orders').insert({
        customer_name: 'Mesa / POS',
        customer_phone: '',
        customer_email: '',
        items: lineItems,
        total: lineItems.reduce((s, i) => s + i.price * i.qty, 0),
        payment_id: 'sq-order-' + orderId,
        receipt_url: '',
        order_type: 'pickup',
        location: locationName,
        notes: '',
        status: 'pending'
      });
      return res.json({ ok: true });
    }

    // Pago recibido — actualiza el pedido existente a pagado
    if (event.type === 'payment.created') {
      const payment = event.data?.object?.payment;
      if (!payment) return res.json({ ok: true });

      if (payment.order_id) {
        const { data: existing } = await supabase
          .from('web_orders')
          .select('id')
          .eq('payment_id', 'sq-order-' + payment.order_id)
          .maybeSingle();

        if (existing) {
          await supabase.from('web_orders')
            .update({ payment_id: payment.id, receipt_url: payment.receipt_url || '', status: 'paid' })
            .eq('id', existing.id);
        }
      }
      return res.json({ ok: true });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Local: node server.js | Vercel: exporta el app como serverless function
if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`Hotdog backend v4 en puerto ${PORT}`));
}

module.exports = app;
