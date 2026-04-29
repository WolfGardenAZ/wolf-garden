// netlify/functions/generate-rental-labels.js
// Generates outbound + return shipping labels via Shippo for rental bookings.

const BOX_SIZES = {
  small:  { length: '12', width: '10', height: '6' },
  medium: { length: '16', width: '12', height: '8' },
  large:  { length: '20', width: '16', height: '12' },
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { bookingId, ownerAddress, renterAddress, packageWeight, packageSize } = JSON.parse(event.body);

    if (!ownerAddress || !renterAddress) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing owner or renter address' }),
      };
    }

    const dims = BOX_SIZES[packageSize] || BOX_SIZES.medium;
    const weightLbs = String(packageWeight || 5);

    // Build Shippo address objects
    const ownerShippoAddress = {
      street1: ownerAddress.street || ownerAddress.line1 || '',
      city: ownerAddress.city || '',
      state: ownerAddress.state || '',
      zip: ownerAddress.zip || ownerAddress.postal_code || '',
      country: 'US',
      validate: false,
    };

    const renterShippoAddress = {
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
      weight: weightLbs,
      mass_unit: 'lb',
    };

    const SHIPPO_API_KEY = process.env.SHIPPO_API_KEY;

    // Helper: create shipment and purchase cheapest label
    async function createLabel(fromAddress, toAddress, reference) {
      // Step 1: Create shipment to get rates
      const shipmentRes = await fetch('https://api.goshippo.com/shipments/', {
        method: 'POST',
        headers: {
          'Authorization': `ShippoToken ${SHIPPO_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          address_from: fromAddress,
          address_to: toAddress,
          parcels: [parcel],
          async: false,
          metadata: `WolfGarden-${reference}`,
        }),
      });

      if (!shipmentRes.ok) {
        const err = await shipmentRes.text();
        throw new Error(`Shipment creation failed: ${err}`);
      }

      const shipment = await shipmentRes.json();

      // Step 2: Pick cheapest USPS or UPS rate
      const rates = (shipment.rates || []).filter(r =>
        ['usps', 'ups', 'fedex'].includes((r.provider || '').toLowerCase()) &&
        r.available_shippo_guaranteed_service_levels !== false
      );

      if (!rates.length) {
        throw new Error('No rates available for this shipment');
      }

      // Sort by price, pick cheapest
      rates.sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount));
      const cheapestRate = rates[0];

      // Step 3: Purchase the rate
      const txRes = await fetch('https://api.goshippo.com/transactions/', {
        method: 'POST',
        headers: {
          'Authorization': `ShippoToken ${SHIPPO_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          rate: cheapestRate.object_id,
          label_file_type: 'PDF',
          async: false,
        }),
      });

      if (!txRes.ok) {
        const err = await txRes.text();
        throw new Error(`Label purchase failed: ${err}`);
      }

      const transaction = await txRes.json();

      if (transaction.status !== 'SUCCESS') {
        throw new Error(`Transaction status: ${transaction.status} — ${transaction.messages?.map(m => m.text).join(', ')}`);
      }

      return {
        labelUrl: transaction.label_url,
        trackingNumber: transaction.tracking_number,
        carrier: cheapestRate.provider,
        serviceName: cheapestRate.servicelevel?.name || '',
        cost: cheapestRate.amount,
      };
    }

    // Generate both labels
    const [outbound, returnLabel] = await Promise.all([
      createLabel(ownerShippoAddress, renterShippoAddress, `${bookingId}-OUT`),
      createLabel(renterShippoAddress, ownerShippoAddress, `${bookingId}-RET`),
    ]);

    console.log(`Labels generated for booking ${bookingId}:`, {
      outboundTracking: outbound.trackingNumber,
      returnTracking: returnLabel.trackingNumber,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        outboundLabelUrl: outbound.labelUrl,
        outboundTracking: outbound.trackingNumber,
        returnLabelUrl: returnLabel.labelUrl,
        returnTracking: returnLabel.trackingNumber,
      }),
    };

  } catch (err) {
    console.error('generate-rental-labels error:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
