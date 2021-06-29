const AWS = require('aws-sdk');
const cloudwatch = new AWS.CloudWatch();
const { Pool } = require('pg')
const pools = {}


function getPool({ip,port,queryTimeoutSeconds,database}) {
  const key = `${ip}-${database}-${queryTimeoutSeconds}`;
  if (!pools[key]) {
    console.log('(new connection)', key);
    const timeout = queryTimeoutSeconds * 60 * 1000;
    pools[key] = new Pool({
      host:ip,
      port,
      database,
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      connectionTimeoutMillis: 30 * 1000,
      query_timeout: timeout,
      statement_timeout: timeout
    });
  } else {
    console.log('(from pool)', key);
  }
  return pools[key];
}


function pickPostgresJson(rows) {
  return rows.map( (row) => {
    return {
      ...row,
      ...row.row_to_json || {},
    }
  })
}

async function sendToCloudWatch(queryName, data, timestamp) {
  const customer = data.opname;

  const metrics = Object.keys(data);

  const MetricData = [];
  metrics.forEach( (metric) => {
    const value = data[metric];
    if (isNaN(value) || typeof(value) === 'undefined' || value == null) {
      return;
    }

    MetricData.push({
      MetricName: metric,
      Dimensions:[
        {
          Name: customer,
          Value: data.cloudwatchDimension
        }
      ],
      Values: [
        value
      ],
      Timestamp: timestamp,
      Unit: 'Count'

    });

  });


  const Params = {
    Namespace: process.env.NAMESPACE,
    MetricData
  }


  if (Params.MetricData.length === 0) {
    console.log(`[${customer}] no valid values for customer... skipping`);
    return;
  }
  console.log('[' + queryName + '] put cloudwatch params', JSON.stringify(Params));
  await cloudwatch.putMetricData(Params).promise();

}

exports.handler = async function (event) {
  const d = new Date();
  const {
    opname,
    cloudwatchDimension,
    query,
    queryName
  } = event;

  console.log('[' + queryName + '] start');
  console.log('event', event);
  const pool = getPool(event);
  const client = await pool.connect();

  try {

    const data = await client.query(query);

    const rows = [];
    for (const row of pickPostgresJson(data.rows)) {
      console.log('[' + queryName + '] have row', row);
      row.opname = opname;
      row.cloudwatchDimension = cloudwatchDimension;
      rows.push(row);
    }

    // Send to CloudWatch
    for (const row of rows) {
      await sendToCloudWatch(queryName, row, d);
    }

  } catch (e) {
    console.error('error running query on', event.ip, event.port, e);
    throw e;
  } finally {
    console.log('[' + queryName + '] done');
    client.release();
  }

}
