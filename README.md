# cloudwatch-onprem

Sample code to get started with Step Functions and CloudWatch monitoring for you existing on-premise deployments. The stack includes the following:

  - Step Function state machines to retrieve data from a database and load into CloudWatch
  - A single metric per customer
  - An alarm per metric per customer
  - An example CloudWatch Anomaly Detection model setup + alarm
  - A CloudWatch overview dashboard
  - A CloudWatch dashboard per customer
  - The ability to optionally set "quiet times", during which the alarms will be silenced.

To read more about it, check out [this article](https://www.inmytree.co.za/blog/monitor-existing-deployments-cloudwatch-step-functions-cdk/)

## Setup

 - Install CDK

 - Create a dev RDS (postgres) in your account, or if you have one already, note the hostname

 - Edit the file lib/customers.ts, and replace the "ip" with the hostname for your RDS.

  ```ts
  const customers: Customer[] = [
    {
      opname: "Customer 1",
      ip: "ip-or-host-name-of-db",
      port: "5432",
      database: "postgres",
      version: Version.v2,
      demoParams: {
        threshold: 5,
        enableAnomalyDetection: true
      },
    },
    {
      opname: "Customer 2",
      ip: "ip-or-host-name-of-db",
      port: "5432",
      database: "postgres",
      version: Version.v1,
      demoParams: {
        threshold: 5
      },
      quietTime: {
        startHourUTC: "0",
        endHourUTC: "4"

      }
    }
  ]

  ```

 - Run the following commands to deploy the demo stack:
  ```sh
  npm install
  cd query-runner
  npm install
  cd ..
  cdk deploy
  ```


For demo purposes, you will get a CloudWatch dashboard (called Overview), 2 alarms (one for each customer) and a dashboard per customer.

## Configuration

Edit the file lib/queries.ts to change queries accordingly:

```ts
export const queries: MetricsQuery[] = [
  {
    name: 'demo-query',
    description: 'A query for demo purposes',
    tags: ['demo'],
    versions: [Version.v1],
    query: `
    select row_to_json(row) from (
       select cos(extract(epoch from current_timestamp) / (60*25)) * 5 + 5 as test_metric
    ) row
    `,
    cloudwatchDimension: 'demo',
  },
  {
    name: 'demo-query',
    description: 'A query for demo purposes',
    tags: ['demo'],
    versions: [Version.v2],
    query: `
    select row_to_json(row) from (
       select sin(extract(epoch from current_timestamp) / (60*25))  * 5 + 5 as test_metric
    ) row
    `,
    cloudwatchDimension: 'demo',
  },

]

```

For demo purposes, the above query simply plot a sine and cosine curve. Of course, you can adjust queries here (or add your own) to pull your own real-time data.

You also need to change the file lib/alarms.ts to adapt the alarms to your newly added metrics:

```ts
    const demoMetric = new cloudwatch.Metric({
      namespace,
      metricName: 'test_metric',
      dimensions: {
        [customer]: 'demo'
      }
    });

```
## Further Customization

If you want to retrieve data from a different type of DB (such as MySQL), you can edit the query-runner in the query-runner/ directory.


