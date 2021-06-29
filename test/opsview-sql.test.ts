import { expect as expectCDK, matchTemplate, MatchStyle } from '@aws-cdk/assert';
import * as cdk from '@aws-cdk/core';
import * as OpsviewSql from '../lib/opsview-sql-stack';

test('Empty Stack', () => {
    const app = new cdk.App();
    // WHEN
    const stack = new OpsviewSql.OpsviewSqlStack(app, 'MyTestStack');
    // THEN
    expectCDK(stack).to(matchTemplate({
      "Resources": {}
    }, MatchStyle.EXACT))
});
