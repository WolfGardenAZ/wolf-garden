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
        body: isRental
          ? `Your rental booking for "${listingTitle}" is confirmed. Total charged: $${amount}. The seller will be in touch shortly with shipping details and return label. Questions? Email wolfgarden21@gmail.com`
          : `Your order for "${listingTitle}" is confirmed. Total charged: $${amount}. The seller will ship your item and provide a tracking number through Wolf Garden messaging. Questions? Email wolfgarden21@gmail.com`,
      });
    }

    // Send seller notification email
    // Note: In production you'd look up seller email from Firebase
    // For now we notify the Wolf Garden admin email
    await sendEmail({
      to: 'wolfgarden21@gmail.com',
      subject: isRental
        ? `Wolf Garden — New Rental Booking: ${listingTitle}`
        : `Wolf Garden — New Sale: ${listingTitle}`,
      body: isRental
        ? `New rental booking on Wolf Garden!\n\nItem: ${listingTitle}\nListing ID: ${listingId}\nAmount: $${amount}\nBuyer email: ${buyerEmail || 'not provided'}\n\nLog in to Wolf Garden to see the details and arrange shipping.`
        : `New sale on Wolf Garden!\n\nItem: ${listingTitle}\nListing ID: ${listingId}\nAmount: $${amount}\nBuyer email: ${buyerEmail || 'not provided'}\n\nLog in to Wolf Garden to see the details and ship the item.`,
    });
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ received: true }),
  };
};

async function sendEmail({ to, subject, body }) {
  // Using Netlify's built-in email via fetch to a simple email API
  // We'll use EmailJS or a simple SMTP approach
  // For now log it - we'll wire up the email service next
  console.log(`EMAIL TO: ${to}`);
  console.log(`SUBJECT: ${subject}`);
  console.log(`BODY: ${body}`);

  // TODO: Wire up email sending service (Resend, SendGrid, etc.)
  return true;
}
