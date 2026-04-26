const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { listing, days, rentalTotal, deposit, buyerEmail } = JSON.parse(event.body);

    if (!listing || !days || !rentalTotal) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing rental data' }) };
    }

    const rentalAmountCents = Math.round(rentalTotal * 100);
    const depositCents = Math.round((deposit || listing.rentalDeposit || 150) * 100);
    const wgFeeCents = Math.round(rentalTotal * 0.05 * 100);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: buyerEmail || undefined,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Rental: ${listing.title}`,
              description: `${days} day rental — Wolf Garden`,
            },
            unit_amount: rentalAmountCents,
          },
          quantity: 1,
        },
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Refundable Security Deposit',
              description: 'Held during rental, released when item returned in same condition',
            },
            unit_amount: depositCents,
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        application_fee_amount: wgFeeCents,
        transfer_data: listing.stripeAccountId ? { destination: listing.stripeAccountId } : undefined,
        metadata: {
          type: 'rental',
          depositAmount: S
