import assert from 'node:assert/strict';
import test from 'node:test';
import {subscriptionCreditWindow} from '../api/me.mjs';

test('a monthly plan uses the exact Stripe billing period',()=>{
  const subscription={billing_interval:'month',current_period_start:'2026-09-30T08:15:27.000Z',current_period_end:'2026-10-30T08:15:27.000Z'};
  assert.deepEqual(subscriptionCreditWindow(subscription,Date.parse('2026-10-12T12:00:00Z')),{
    start:'2026-09-30T08:15:27.000Z',
    end:'2026-10-30T08:15:27.000Z',
  });
});

test('an annual plan derives each month from the original anchor without end-of-month drift',()=>{
  const leapYear={billing_interval:'year',current_period_start:'2024-01-31T10:45:00.000Z',current_period_end:'2025-01-31T10:45:00.000Z'};
  assert.deepEqual(subscriptionCreditWindow(leapYear,Date.parse('2024-02-29T10:45:00.000Z')), {
    start:'2024-02-29T10:45:00.000Z',
    end:'2024-03-31T10:45:00.000Z',
  });
  assert.deepEqual(subscriptionCreditWindow(leapYear,Date.parse('2024-03-30T12:00:00.000Z')), {
    start:'2024-02-29T10:45:00.000Z',
    end:'2024-03-31T10:45:00.000Z',
  });
  assert.deepEqual(subscriptionCreditWindow(leapYear,Date.parse('2024-03-31T10:45:00.000Z')), {
    start:'2024-03-31T10:45:00.000Z',
    end:'2024-04-30T10:45:00.000Z',
  });
});

test('the last annual credit window is capped at the Stripe period end',()=>{
  const subscription={billing_interval:'year',current_period_start:'2025-02-28T23:00:00.000Z',current_period_end:'2026-02-28T22:59:00.000Z'};
  assert.deepEqual(subscriptionCreditWindow(subscription,Date.parse('2026-02-28T20:00:00.000Z')), {
    start:'2026-01-28T23:00:00.000Z',
    end:'2026-02-28T22:59:00.000Z',
  });
  assert.equal(subscriptionCreditWindow(subscription,Date.parse('2026-02-28T22:59:00.000Z')),null);
});
