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
        const startDate = session.metadata?.startDate || '';
        const endDate = session.metadata?.endDate || '';
       const renterAddress = session.shipping_details?.address || session.customer_details?.address || null;
       console.log('Renter address from session:', JSON.stringify(renterAddress));

        // Fetch listing from Firestore to get owner ship-from address and package info
        let shipFromAddress = null;
        let packageWeight = parseFloat(session.metadata?.packageWeight || '5');
        let packageSize = session.metadata?.packageSize || 'medium';

        const listingSnap = await db.collection('listings')
          .where('id', '==', parseInt(listingId))
          .get();
        if (!listingSnap.empty) {
          const listingData = listingSnap.docs[0].data();
          shipFromAddress = listingData.shipFromAddress || null;
          if (listingData.packageWeight) packageWeight = listingData.packageWeight;
          if (listingData.packageSize) packageSize = listingData.packageSize;
        }

        // Generate shipping labels inline (Shippo)
        let outboundLabelUrl = null;
        let returnLabelUrl = null;

        if (shipFromAddress && renterAddress) {
          try {
            const BOX_SIZES = {
              small:  { length: '12', width: '10', height: '6' },
              medium: { length: '16', width: '12', height: '8' },
              large:  { length: '20', width: '16', height: '12' },
            };
            const dims = BOX_SIZES[packageSize] || BOX_SIZES.medium;
            const SHIPPO_API_KEY = process.env.SHIPPO_API_KEY;

            const ownerShippoAddress = {
              name: 'Wolf Garden Seller',
              phone: '5205550000',
              street1: shipFromAddress.street || shipFromAddress.line1 || '',
              city: shipFromAddress.city || '',
              state: shipFromAddress.state || '',
              zip: shipFromAddress.zip || shipFromAddress.postal_code || '',
              country: 'US',
              validate: false,
            };

            const renterShippoAddress = {
              name: 'Wolf Garden Renter',
              phone: '5205550000',
              street1: renterAddress.line1 || '',
              street2: renterAddress.line2 || '',
              city: renterAddress.city || '',
              state: renterAddress.state || '',
              zip: renterAddress.postal_code || '',
              country: 'US',
              validate: false,
            };

            const parcel = {
              length: dims.length,
              width: dims.width,
              height: dims.height,
              distance_unit: 'in',
              weight: String(packageWeight || 5),
              mass_unit: 'lb',
            };

            async function createShippoLabel(fromAddr, toAddr, ref) {
              const shipRes = await fetch('https://api.goshippo.com/shipments/', {
                method: 'POST',
                headers: { 'Authorization': `ShippoToken ${SHIPPO_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ address_from: fromAddr, address_to: toAddr, parcels: [parcel], async: false }),
              });
              const shipment = await shipRes.json();
              const rates = (shipment.rates || []).filter(r => (r.provider || '').toLowerCase() === 'usps' && r.object_id);
              if (!rates.length) throw new Error(`No USPS rates for ${ref}`);
              rates.sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount));
              const txRes = await fetch('https://api.goshippo.com/transactions/', {
                method: 'POST',
                headers: { 'Authorization': `ShippoToken ${SHIPPO_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ rate: rates[0].object_id, label_file_type: 'PDF', async: false }),
              });
              const tx = await txRes.json();
              if (tx.status !== 'SUCCESS') throw new Error(`Label error for ${ref}: ${tx.messages?.map(m => m.text).join(', ')}`);
              return tx.label_url;
            }

            const [outUrl, retUrl] = await Promise.all([
              createShippoLabel(ownerShippoAddress, renterShippoAddress, `${bookingId}-OUT`),
              createShippoLabel(renterShippoAddress, ownerShippoAddress, `${bookingId}-RET`),
            ]);
            outboundLabelUrl = outUrl;
            returnLabelUrl = retUrl;
            console.log(`Labels generated: OUT=${outboundLabelUrl} RET=${returnLabelUrl}`);
          } catch (labelErr) {
            console.error('Label generation error:', labelErr.message);
          }
        } else {
          console.log('Skipping label generation — missing addresses. shipFrom:', !!shipFromAddress, 'renter:', !!renterAddress);
        }

        await db.collection('rentalBookings').doc(bookingId).set({
          bookingId,
          listingId,
          listingTitle,
          ownerEmail,
          renterEmail: buyerEmail || '',
          renterAddress: renterAddress || null,
          totalAmount: amount,
          deposit: session.metadata?.depositAmount || 0,
          startDate,
          endDate,
          outboundLabelUrl,
          returnLabelUrl,
          status: 'active',
          ownerPhotos: [],
          renterPhotos: [],
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        const ownerUploadUrl = `https://wolfgardenaz.com/rental-photos.html?booking=${bookingId}&role=owner`;
        const renterUploadUrl = `https://wolfgardenaz.com/rental-photos.html?booking=${bookingId}&role=renter`;

        const labelSection = (outboundLabelUrl && returnLabelUrl) ? `
          <div style="margin-top:1.5rem;padding:1rem;background:#1a1a1a;border-left:3px solid #C9973A;">
            <strong style="color:#C9973A;">📦 Shipping Labels Ready</strong><br>
            <p style="margin-top:0.5rem;">Print the outbound label and ship within 24 hours. Put the return label inside the box.</p>
            <p style="margin-top:0.75rem;">
              <a href="${outboundLabelUrl}" style="display:inline-block;background:#4A7FA5;color:white;padding:10px 20px;text-decoration:none;font-weight:bold;border-radius:4px;margin-right:0.5rem;">🖨️ Print Outbound Label</a>
              <a href="${returnLabelUrl}" style="display:inline-block;background:#555;color:white;padding:10px 20px;text-decoration:none;font-weight:bold;border-radius:4px;">📄 Return Label (put in box)</a>
            </p>
          </div>` : `
          <div style="margin-top:1.5rem;padding:1rem;background:#1a1a1a;border-left:3px solid #888;">
            <strong style="color:#aaa;">⚠️ Shipping Labels</strong><br>
            <p style="margin-top:0.5rem;color:#888;">Labels couldn't be generated automatically. Contact wolfgarden21@gmail.com and we'll get them to you.</p>
          </div>`;

        // Email owner
        if (ownerEmail) {
          await sendEmail({
            to: ownerEmail,
            subject: `Action Required — Photograph gear before shipping: ${listingTitle}`,
            html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
              <h2 style="color:#C9973A;">Wolf Garden — New Rental Booking</h2>
              <p>Your <strong>${listingTitle}</strong> has been booked for rental.</p>
              <p><strong>Rental dates:</strong> ${startDate || '—'} → ${endDate || '—'}</p>
              <p><strong>Amount you'll receive:</strong> $${amount}</p>
              <p style="margin-top:1.5rem;padding:1rem;background:#1a1a1a;border-left:3px solid #C9973A;">
                <strong style="color:#C9973A;">⚠️ Required before shipping:</strong><br>
                Photograph the gear thoroughly before you pack it. These photos protect you if there is any dispute about damage.
              </p>
              <p style="margin-top:1rem;">
                <a href="${ownerUploadUrl}" style="display:inline-block;background:#9C27B0;color:white;padding:12px 24px;text-decoration:none;font-weight:bold;border-radius:4px;">📸 Upload Pre-Ship Photos</a>
              </p>
              ${labelSection}
              <p style="color:#888;font-size:0.85rem;margin-top:1.5rem;">Questions? Email <a href="mailto:wolfgarden21@gmail.com">wolfgarden21@gmail.com</a></p>
            </div>`,
          });
        }

        // Email renter
        if (buyerEmail) {
          await sendEmail({
            to: buyerEmail,
            subject: `Wolf Garden — Rental Confirmed: ${listingTitle}`,
            html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
              <h2 style="color:#C9973A;">Wolf Garden — Rental Booking Confirmed</h2>
              <p>Your rental of <strong>${listingTitle}</strong> is confirmed.</p>
              <p><strong>Rental dates:</strong> ${startDate || '—'} → ${endDate || '—'}</p>
              <p><strong>Total charged: $${amount}</strong></p>
              <p style="margin-top:1.5rem;padding:1rem;background:#1a1a1a;border-left:3px solid #9C27B0;">
                <strong style="color:#CE93D8;">📦 When your gear arrives:</strong><br>
                Photograph everything immediately before you use it. This protects you from being held responsible for any pre-existing damage. A prepaid return label is included in the box — use it to ship back on or before your last rental day.
              </p>
              <p style="margin-top:1rem;">
                <a href="${renterUploadUrl}" style="display:inline-block;background:#9C27B0;color:white;padding:12px 24px;text-decoration:none;font-weight:bold;border-radius:4px;">📸 Upload Arrival Photos</a>
              </p>
              <p style="color:#888;font-size:0.85rem;margin-top:1.5rem;">Questions? Email <a href="mailto:wolfgarden21@gmail.com">wolfgarden21@gmail.com</a></p>
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

    // Send seller shipping reminder email (non-rental)
    const sellerEmail = session.metadata?.sellerEmail || session.metadata?.ownerEmail || '';
    if (sellerEmail && !isRental) {
      await sendEmail({
        to: sellerEmail,
        subject: `Action Required — Ship your item: ${listingTitle}`,
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
          <h2 style="color:#C9973A;">Wolf Garden — Item Sold!</h2>
          <p>Your <strong>${listingTitle}</strong> has been purchased.</p>
          <p><strong>Sale amount: $${amount}</strong></p>
          <p style="margin-top:1.5rem;padding:1rem;background:#1a1a1a;border-left:3px solid #C9973A;">
            <strong style="color:#C9973A;">⚠️ Next steps:</strong><br>
            Ship the item as soon as possible and provide the buyer with a tracking number through Wolf Garden messaging. Buyers expect fast shipping — aim to ship within 1-2 business days.
          </p>
          <p style="margin-top:1rem;">Compare shipping rates at <a href="https://www.usps.com" style="color:#C9973A;">USPS</a>, <a href="https://www.ups.com" style="color:#C9973A;">UPS</a>, or <a href="https://www.fedex.com" style="color:#C9973A;">FedEx</a> before shipping.</p>
          <p style="color:#888;font-size:0.85rem;margin-top:1.5rem;">Questions? Email <a href="mailto:wolfgarden21@gmail.com">wolfgarden21@gmail.com</a></p>
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
