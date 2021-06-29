import { Version } from './customers';

interface MetricsQuery {
  name: string;
  description: string;
  versions: Version[];
  query: string;
  cloudwatchDimension: string;
  tags: string[];
}

export const queries: MetricsQuery[] = [
  {
    name: 'demo-query',
    description: 'A query for demo purposes',
    tags: ['demo'],
    versions: [Version.v1],
    query: `
    select row_to_json(row) from (
       select cos(extract(epoch from current_timestamp) / (60*25)) * 5 + 5 as test_metric,
              cos(extract(epoch from current_timestamp) / (60*25) + 3.14/2) * 5 + 5 as test_metric2
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
       select cos(extract(epoch from current_timestamp) / (60*25) + 3.14)  * 5 + 5 as test_metric,
              cos(extract(epoch from current_timestamp) / (60*25) + 3.14/4)  * 5 + 5 as test_metric2
    ) row
    `,
    cloudwatchDimension: 'demo',
  },

]

