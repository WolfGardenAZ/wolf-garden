exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { toZip, weight, length, width, height } = JSON.parse(event.body);

    if (!toZip) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing destination zip' }) };
    }

    const shippoKey = process.env.SHIPPO_API_KEY;
    if (!shippoKey) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Shippo API key not configured' }) };
    }

    const shipmentRes = await fetch('https://api.goshippo.com/shipments/', {
      method: 'POST',
      headers: {
        'Authorization': `ShippoToken ${shippoKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        address_from: {
          name: 'Wolf Garden Seller',
          street1: '123 Main St',
          city: 'Phoenix',
          state: 'AZ',
          zip: '85001',
          country: 'US',
        },
        address_to: {
          name: 'Buyer',
          street1: '1 Main St',
          city: 'Anywhere',
          state: 'XX',
          zip: toZip,
          country: 'US',
        },
        parcels: [{
          length: String(length || 12),
          width: String(width || 10),
          height: String(height || 6),
          distance_unit: 'in',
          weight: String(weight || 2),
          mass_unit: 'lb',
        }],
        async: false,
      }),
    });

    const shipment = await shipmentRes.json();

    if (!shipment.rates || shipment.rates.length === 0) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rates: [] }),
      };
    }

    const rates = shipment.rates
      .filter(r => r.amount && r.provider && r.servicelevel)
      .map(r => ({
        rateId: r.object_id,
        provider: r.provider,
        service: r.servicelevel.name,
        amount: parseFloat(r.amount),
        currency: r.currency,
        days: r.estimated_days,
      }))
      .sort((a, b) => a.amount - b.amount)
      .slice(0, 5);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rates, shipmentId: shipment.object_id }),
    };
  } catch (err) {
    console.error('Shippo rates error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
