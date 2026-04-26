const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { listing, buyerEmail } = JSON.parse(event.body);

    if (!listing || !listing.price || !listing.title) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing listing data' }) };
    }

    const priceInCents = Math.round(listing.price * 100);
    const wgFeeInCents = Math.round(listing.price * 0.05 * 100);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: buyerEmail || undefined,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: listing.title,
              description: listing.category ? `${listing.category} — Wolf Garden Marketplace` : 'Wolf Garden Marketplace',
            },
            unit_amount: priceInCents,
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        application_fee_amount: wgFeeInCents,
        transfer_data: listing.stripeAccountId ? { destination: listing.stripeAccountId } : undefined,
      },
      metadata: {
        listingId: String(listing.id),
        listingTitle: listing.title,
        sellerId: String(listing.sellerId || ''),
      },
      success_url: `${event.headers.origin || 'https://wolfgardenaz.com'}/?payment=success&listing=${listing.id}`,
      cancel_url: `${event.headers.origin || 'https://wolfgardenaz.com'}/?payment=cancelled`,
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url, sessionId: session.id }),
    };
  } catch (err) {
    console.error('Stripe checkout error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
