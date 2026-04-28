const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const sig = event.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;
    const listingId = session.metadata?.listingId;
    const listingTitle = session.metadata?.listingTitle;
    const isRental = session.metadata?.type === 'rental';
    const buyerEmail = session.customer_email;
    const amount = (session.amount_total / 100).toFixed(2);

    console.log(`Payment completed for listing ${listingId}: ${listingTitle}`);

    // Send buyer confirmation email
    if (buyerEmail) {
      await sendEmail({
        to: buyerEmail,
        subject: isRental
          ? `Wolf Garden — Rental Booking Confirmed: ${listingTitle}`
          : `Wolf Garden — Order Confirmed: ${listingTitle}`,
        html: isRental
          ? `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
              <h2 style="color:#C9973A;">Wolf Garden</h2>
              <p>Your rental booking for <strong>${listingTitle}</strong> is confirmed.</p>
              <p><strong>Total charged: $${amount}</strong></p>
              <p>The seller will be in touch shortly with shipping details.</p>
              <p style="color:#888;font-size:0.85rem;">Questions? Email <a href="mailto:wolfgarden21@gmail.com">wolfgarden21@gmail.com</a></p>
            </div>`
          : `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
              <h2 style="color:#C9973A;">Wolf Garden</h2>
              <p>Your order for <strong>${listingTitle}</strong> is confirmed.</p>
              <p><strong>Total charged: $${amount}</strong></p>
              <p>The seller will ship your item and provide tracking through Wolf Garden messaging.</p>
              <p style="color:#888;font-size:0.85rem;">Questions? Email <a href="mailto:wolfgarden21@gmail.com">wolfgarden21@gmail.com</a></p>
            </div>`,
      });
    }

    // Notify Wolf Garden admin of new sale
    await sendEmail({
      to: 'wolfgarden21@gmail.com',
      subject: isRental
        ? `New Rental Booking: ${listingTitle}`
        : `New Sale: ${listingTitle}`,
      html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
        <h2 style="color:#C9973A;">Wolf Garden — New ${isRental ? 'Rental' : 'Sale'}</h2>
        <p><strong>Item:</strong> ${listingTitle}</p>
        <p><strong>Listing ID:</strong> ${listingId}</p>
        <p><strong>Amount:</strong> $${amount}</p>
        <p><strong>Buyer email:</strong> ${buyerEmail || 'not provided'}</p>
      </div>`,
    });
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ received: true }),
  };
};

async function sendEmail({ to, subject, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Wolf Garden <noreply@wolfgardenaz.com>',
      to,
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Resend error:', err);
  }
}
