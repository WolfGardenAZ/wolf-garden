const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

// Initialize Firebase Admin once
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    )
  });
}
const db = admin.firestore();

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

    // Mark listing as sold in Firestore
    if (listingId && !isRental) {
      try {
        const snapshot = await db.collection('listings')
          .where('id', '==', parseInt(listingId))
          .get();
        if (!snapshot.empty) {
          snapshot.forEach(doc => doc.ref.update({ sold: true }));
          console.log(`Listing ${listingId} marked as sold`);
        }
      } catch (err) {
        console.error('Firestore sold update error:', err.message);
      }
    }

    // Create rental booking record if this is a rental
    if (isRental && listingId) {
      try {
        const bookingId = 'booking_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        const ownerEmail = session.metadata?.ownerEmail || '';

        await db.collection('rentalBookings').doc(bookingId).set({
          bookingId,
          listingId,
          listingTitle,
          ownerEmail,
          renterEmail: buyerEmail || '',
          totalAmount: amount,
          deposit: session.metadata?.deposit || 0,
          status: 'active',
          ownerPhotos: [],
          renterPhotos: [],
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        const ownerUploadUrl = `https://wolfgardenaz.com/rental-photos.html?booking=${bookingId}&role=owner`;
        const renterUploadUrl = `https://wolfgardenaz.com/rental-photos.html?booking=${bookingId}&role=renter`;

        // Email owner their photo upload link
        if (ownerEmail) {
          await sendEmail({
            to: ownerEmail,
            subject: `Action Required — Photograph gear before shipping: ${listingTitle}`,
            html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
              <h2 style="color:#C9973A;">Wolf Garden — New Rental Booking</h2>
              <p>Your <strong>${listingTitle}</strong> has been booked for rental.</p>
              <p><strong>Amount you'll receive:</strong> $${amount}</p>
              <p style="margin-top:1.5rem;padding:1rem;background:#1a1a1a;border-left:3px solid #C9973A;">
                <strong style="color:#C9973A;">⚠️ Required before shipping:</strong><br>
                Photograph the gear thoroughly before you pack it. These photos protect you if there is any dispute about damage.
              </p>
              <p style="margin-top:1rem;">
                <a href="${ownerUploadUrl}" style="display:inline-block;background:#9C27B0;color:white;padding:12px 24px;text-decoration:none;font-weight:bold;border-radius:4px;">📸 Upload Pre-Ship Photos</a>
              </p>
              <p style="color:#888;font-size:0.85rem;margin-top:1.5rem;">Ship within 24 hours of the rental start date. Questions? Email <a href="mailto:wolfgarden21@gmail.com">wolfgarden21@gmail.com</a></p>
            </div>`,
          });
        }

        // Email renter their photo upload link
        if (buyerEmail) {
          await sendEmail({
            to: buyerEmail,
            subject: `Wolf Garden — Rental Confirmed: ${listingTitle}`,
            html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
              <h2 style="color:#C9973A;">Wolf Garden — Rental Booking Confirmed</h2>
              <p>Your rental of <strong>${listingTitle}</strong> is confirmed.</p>
              <p><strong>Total charged: $${amount}</strong></p>
              <p style="margin-top:1.5rem;padding:1rem;background:#1a1a1a;border-left:3px solid #9C27B0;">
                <strong style="color:#CE93D8;">📦 When your gear arrives:</strong><br>
                Photograph everything immediately before you use it. This protects you from being held responsible for any pre-existing damage.
              </p>
              <p style="margin-top:1rem;">
                <a href="${renterUploadUrl}" style="display:inline-block;background:#9C27B0;color:white;padding:12px 24px;text-decoration:none;font-weight:bold;border-radius:4px;">📸 Upload Arrival Photos</a>
              </p>
              <p style="color:#888;font-size:0.85rem;margin-top:1.5rem;">The owner will ship with a prepaid return label inside the box. Questions? Email <a href="mailto:wolfgarden21@gmail.com">wolfgarden21@gmail.com</a></p>
            </div>`,
          });
        }

        console.log(`Rental booking created: ${bookingId}`);
      } catch (err) {
        console.error('Rental booking creation error:', err.message);
      }
    }

    // Send buyer confirmation email (non-rental)
    if (buyerEmail && !isRental) {
      await sendEmail({
        to: buyerEmail,
        subject: `Wolf Garden — Order Confirmed: ${listingTitle}`,
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
          <h2 style="color:#C9973A;">Wolf Garden</h2>
          <p>Your order for <strong>${listingTitle}</strong> is confirmed.</p>
          <p><strong>Total charged: $${amount}</strong></p>
          <p>The seller will ship your item and provide tracking through Wolf Garden messaging.</p>
          <p style="color:#888;font-size:0.85rem;">Questions? Email <a href="mailto:wolfgarden21@gmail.com">wolfgarden21@gmail.com</a></p>
        </div>`,
      });
    }

    // Notify Wolf Garden admin of new sale or rental
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
