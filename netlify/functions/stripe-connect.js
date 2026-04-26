const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { userId, email, action, stripeAccountId } = JSON.parse(event.body);

    if (!userId || !email) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing userId or email' }) };
    }

    const origin = event.headers.origin || 'https://wolfgardenaz.com';

    if (action === 'create') {
      const account = await stripe.accounts.create({
        type: 'express',
        email: email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        metadata: { userId: String(userId) },
      });

      const accountLink = await stripe.accountLinks.create({
        account: account.id,
        refresh_url: `${origin}/?connect=refresh&userId=${userId}`,
        return_url: `${origin}/?connect=success&userId=${userId}&accountId=${account.id}`,
        type: 'account_onboarding',
      });

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: account.id, onboardingUrl: accountLink.url }),
      };
    }

    if (action === 'link') {
      const accountLink = await stripe.accountLinks.create({
        account: stripeAccountId,
        refresh_url: `${origin}/?connect=refresh&userId=${userId}`,
        return_url: `${origin}/?connect=success&userId=${userId}&accountId=${stripeAccountId}`,
        type: 'account_onboarding',
      });

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ onboardingUrl: accountLink.url }),
      };
    }

    if (action === 'status') {
      const account = await stripe.accounts.retrieve(stripeAccountId);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chargesEnabled: account.charges_enabled,
          payoutsEnabled: account.payouts_enabled,
          detailsSubmitted: account.details_submitted,
        }),
      };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid action' }) };
  } catch (err) {
    console.error('Connect error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
