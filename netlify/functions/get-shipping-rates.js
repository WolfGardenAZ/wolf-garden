exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { toZip, weight, length, width, height } = JSON.parse(event.body);

    const shippoKey = process.env.SHIPPO_API_KEY;
    if (!shippoKey) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Shippo not configured' }) };
    }

    const shipmentBody = {
      address_from: {
        name: 'Wolf Garden Seller',
        street1: '1 Main St',
        city: 'Phoenix',
        state: 'AZ',
        zip: '85001',
        country: 'US',
      },
      address_to: {
        name: 'Wolf Garden Buyer',
        street1: '1 Main St',
        city: 'Tucson',
        state: 'AZ',
        zip: toZip || '85715',
        country: 'US',
      },
      parcels: [
        {
          length: String(length || 12),
          width: String(width || 10),
          height: String(height || 6),
          distance_unit: 'in',
          weight: String(weight || 2),
          mass_unit: 'lb',
        },
      ],
      async: false,
    };

    const response = await fetch('https://api.goshippo.com/shipments/', {
      method: 'POST',
      headers: {
        'Authorization': `ShippoToken ${shippoKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(shipmentBody),
    });

    const data = await response.json();

    if (!data.rates || data.rates.length === 0) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rates: [], debug: data }),
      };
    }

    const rates = data.rates
      .filter(r => r.amount && r.provider && r.servicelevel)
      .map(r => ({
        provider: r.provider,
        service: r.servicelevel.name,
        amount: parseFloat(r.amount),
        currency: r.currency,
        days: r.estimated_days,
        rateId: r.object_id,
      }))
      .sort((a, b) => a.amount - b.amount)
      .slice(0, 5);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rates }),
    };
  } catch (err) {
    console.error('Shippo error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
