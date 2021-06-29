const aws = require('aws-sdk');
const s3 = new aws.S3();
const cloudwatch = new aws.CloudWatch();

async function sendRecord(data) {
  const operator = data.customer;


  const metrics = Object.keys(data);

  const MetricData = [];
  metrics.forEach( (metric) => {
    const value = data[metric];
    if (isNaN(value)) {
      console.warn(operator,metric,'value',value,'is not a number... skipping');
      return;
    }

    //console.log('operator,metric', operator, metric, value);

    MetricData.push({
      MetricName: metric,
      Dimensions:[
        {
          Name: operator,
          Value: 'Status'
        }
      ],
      Values: [
        value
      ],
      Unit: 'Count'

    });


  });


  const Params = {
    Namespace: process.env.NAMESPACE,
    MetricData
  }


  if (Params.MetricData.length === 0) {
    console.log(`[${operator}] no valid values for opco... skipping`);
    return;
  }
  console.log('put cloudwatch params', JSON.stringify(Params));
  await cloudwatch.putMetricData(Params).promise();

}

exports.handler = async function (event) {

  const now = new Date();
  const hour = now.getHours();

  for (const qt of event.quietTimes) {

    const {customer,quietTime} = qt;

    const startHourUTC = parseFloat(quietTime.startHourUTC);
    const endHourUTC = parseFloat(quietTime.endHourUTC);

    const quiet_time = (hour >= startHourUTC && hour < endHourUTC) ? 1 : 0;

    await sendRecord({
      customer,
      quiet_time
    })


  }

}
