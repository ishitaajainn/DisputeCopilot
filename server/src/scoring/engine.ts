import {
  PayPalDispute,
  RubricItemResult,
  ScoreResult,
  StandardDisputeReason,
  StoreOrder,
} from '../types/dispute.js';
import {
  getScoreBand,
  INR_RUBRIC_WEIGHTS,
  SNAD_RUBRIC_WEIGHTS,
} from './weights.js';

export function normalizeDisputeReason(
  reason: string
): StandardDisputeReason | 'UNKNOWN' {
  const upper = reason.toUpperCase().trim();
  if (
    upper === 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' ||
    upper === 'ITEM_NOT_RECEIVED' ||
    upper === 'INR'
  ) {
    return 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED';
  }
  if (
    upper === 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' ||
    upper === 'NOT_AS_DESCRIBED' ||
    upper === 'SNAD'
  ) {
    return 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED';
  }
  return 'UNKNOWN';
}

export function scoreDispute(
  dispute: PayPalDispute,
  order?: StoreOrder | null
): ScoreResult {
  const standardReason = normalizeDisputeReason(dispute.reason);

  if (standardReason === 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED') {
    return scoreItemNotReceived(dispute, order);
  }

  if (standardReason === 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED') {
    return scoreNotAsDescribed(dispute, order);
  }

  // Fallback for unknown reasons
  return {
    totalScore: 0,
    band: 'weak',
    disputeReason: 'UNKNOWN',
    breakdown: [],
    summary: `Unsupported dispute reason: ${dispute.reason}`,
  };
}

function scoreItemNotReceived(
  dispute: PayPalDispute,
  order?: StoreOrder | null
): ScoreResult {
  const breakdown: RubricItemResult[] = [];
  let totalScore = 0;

  const disputeDate = new Date(dispute.create_time).getTime();
  const deliveryEvent = order?.trackingEvents?.find((event) => {
  if (event.status.toUpperCase() !== 'DELIVERED') {
    return false;
  }

  const timestamp = new Date(event.time).getTime();

  return Number.isFinite(timestamp);
});

const deliveryTime = deliveryEvent
  ? new Date(deliveryEvent.time).getTime()
  : null;

  // 1. Tracking number exists (+20)
  const hasTracking = Boolean(order?.trackingNumber && order?.carrier);
  const w1 = INR_RUBRIC_WEIGHTS.find((w) => w.id === 'INR_TRACKING_EXISTS')!;
  if (hasTracking) {
    totalScore += w1.points;
    breakdown.push({
      id: w1.id,
      title: w1.title,
      pointsPossible: w1.points,
      pointsAwarded: w1.points,
      passed: true,
      reason: `Tracking provided with ${order?.carrier}: ${order?.trackingNumber}`,
    });
  } else {
    breakdown.push({
      id: w1.id,
      title: w1.title,
      pointsPossible: w1.points,
      pointsAwarded: 0,
      passed: false,
      reason: 'No carrier tracking number associated with this order.',
    });
  }

  // 2. Carrier status delivered (+30)
  const isDelivered = Boolean(deliveryEvent);
  const w2 = INR_RUBRIC_WEIGHTS.find((w) => w.id === 'INR_STATUS_DELIVERED')!;
  if (isDelivered) {
    totalScore += w2.points;
    breakdown.push({
      id: w2.id,
      title: w2.title,
      pointsPossible: w2.points,
      pointsAwarded: w2.points,
      passed: true,
      reason: `Confirmed delivered at ${deliveryEvent?.location || 'destination'}`,
    });
  } else {
    breakdown.push({
      id: w2.id,
      title: w2.title,
      pointsPossible: w2.points,
      pointsAwarded: 0,
      passed: false,
      reason: 'Tracking does not indicate final delivery to buyer.',
    });
  }

  // 3. Delivered before dispute date (+10)
  const w3 = INR_RUBRIC_WEIGHTS.find(
    (w) => w.id === 'INR_DELIVERED_BEFORE_DISPUTE'
  )!;
  if (deliveryTime && deliveryTime <= disputeDate) {
    totalScore += w3.points;
    breakdown.push({
      id: w3.id,
      title: w3.title,
      pointsPossible: w3.points,
      pointsAwarded: w3.points,
      passed: true,
      reason: `Package delivered on ${new Date(deliveryTime).toISOString().split('T')[0]}, before dispute opened on ${new Date(disputeDate).toISOString().split('T')[0]}`,
    });
  } else {
    breakdown.push({
      id: w3.id,
      title: w3.title,
      pointsPossible: w3.points,
      pointsAwarded: 0,
      passed: false,
      reason: deliveryTime
        ? 'Delivery timestamp is after or on the dispute creation time.'
        : 'Cannot verify delivery date relative to dispute date.',
    });
  }

  // 4. Signature on delivery (+15)
  const w4 = INR_RUBRIC_WEIGHTS.find(
    (w) => w.id === 'INR_SIGNATURE_ON_DELIVERY'
  )!;
  const hasSignature = Boolean(deliveryEvent?.signedBy);
  if (hasSignature) {
    totalScore += w4.points;
    breakdown.push({
      id: w4.id,
      title: w4.title,
      pointsPossible: w4.points,
      pointsAwarded: w4.points,
      passed: true,
      reason: `Delivery signed by recipient: ${deliveryEvent?.signedBy}`,
    });
  } else {
    breakdown.push({
      id: w4.id,
      title: w4.title,
      pointsPossible: w4.points,
      pointsAwarded: 0,
      passed: false,
      reason: 'No recipient signature recorded on delivery.',
    });
  }

   // 5. Delivery address matches transaction shipping address (+15)
  const w5 = INR_RUBRIC_WEIGHTS.find(
    (w) => w.id === 'INR_ADDRESS_MATCHES'
  )!;

  // Transaction shipping address is not currently available
  // for comparison, so this criterion remains unverified.
  breakdown.push({
    id: w5.id,
    title: w5.title,
    pointsPossible: w5.points,
    pointsAwarded: 0,
    passed: false,
    reason:
      'Address match cannot be verified because the transaction shipping address is unavailable.',
  });

  // 6. No customer complaint messages before delivery (+5)
  const w6 = INR_RUBRIC_WEIGHTS.find(
    (w) => w.id === 'INR_NO_PRE_DELIVERY_COMPLAINT'
  )!;
  const hasMessageHistory = Array.isArray(order?.customerMessages);

const preDeliveryComplaint = hasMessageHistory && deliveryTime !== null
  ? order.customerMessages.some((msg) => {
      if (msg.from !== 'customer') return false;

      const msgTime = new Date(msg.time).getTime();

      return Number.isFinite(msgTime) && msgTime < deliveryTime;
    })
  : null;
  if (preDeliveryComplaint === false) {
  totalScore += w6.points;
  breakdown.push({
    id: w6.id,
    title: w6.title,
    pointsPossible: w6.points,
    pointsAwarded: w6.points,
    passed: true,
    reason: 'No pre-delivery customer complaint found in available communication history.',
  });
} else {
  breakdown.push({
    id: w6.id,
    title: w6.title,
    pointsPossible: w6.points,
    pointsAwarded: 0,
    passed: false,
    reason: preDeliveryComplaint === null
      ? 'Customer communication history or valid delivery time is unavailable.'
      : 'Customer sent a complaint before delivery.',
  });
}
  

  // 7. No prior refund (+5)
  const w7 = INR_RUBRIC_WEIGHTS.find((w) => w.id === 'INR_NO_PRIOR_REFUND')!;
  const hasRefundHistory = Array.isArray(order?.refunds);
const hasPriorRefund = hasRefundHistory
  ? order.refunds.length > 0
  : null;

if (hasPriorRefund === false) {
  totalScore += w7.points;
  breakdown.push({
    id: w7.id,
    title: w7.title,
    pointsPossible: w7.points,
    pointsAwarded: w7.points,
    passed: true,
    reason: 'No prior refunds recorded in available order history.',
  });
} else {
  breakdown.push({
    id: w7.id,
    title: w7.title,
    pointsPossible: w7.points,
    pointsAwarded: 0,
    passed: false,
    reason: hasPriorRefund === null
      ? 'Refund history is unavailable.'
      : 'Prior refund or goodwill concession was already issued.',
  });
}

  const band = getScoreBand(totalScore);
  return {
    totalScore,
    band,
    disputeReason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    breakdown,
    summary: `Item Not Received claim assessed at ${totalScore}/100 (${band.toUpperCase()} defense strength).`,
  };
}


function scoreNotAsDescribed(
  dispute: PayPalDispute,
  order?: StoreOrder | null
): ScoreResult {
  const breakdown: RubricItemResult[] = [];
  let totalScore = 0;

  // Find a delivery event with a valid timestamp
  const deliveryEvent = order?.trackingEvents?.find((event) => {
    if (event.status.toUpperCase() !== 'DELIVERED') {
      return false;
    }

    return Number.isFinite(new Date(event.time).getTime());
  });

  const deliveryTime = deliveryEvent
    ? new Date(deliveryEvent.time).getTime()
    : null;

  // 1. Listing matches delivered item (+25)
  const w1 = SNAD_RUBRIC_WEIGHTS.find(
    (w) => w.id === 'SNAD_LISTING_MATCHES'
  )!;

  breakdown.push({
    id: w1.id,
    title: w1.title,
    pointsPossible: w1.points,
    pointsAwarded: 0,
    passed: false,
    reason:
      'Evidence comparing the delivered item with the original listing is unavailable.',
  });

  // 2. Return policy shown to buyer (+15)
  const w2 = SNAD_RUBRIC_WEIGHTS.find(
    (w) => w.id === 'SNAD_RETURN_POLICY'
  )!;

  breakdown.push({
    id: w2.id,
    title: w2.title,
    pointsPossible: w2.points,
    pointsAwarded: 0,
    passed: false,
    reason:
      'The return policy text is recorded, but proof that it was displayed to the buyer is unavailable.',
  });

  // 3. No earlier customer complaint (+15)
  const w3 = SNAD_RUBRIC_WEIGHTS.find(
    (w) => w.id === 'SNAD_NO_EARLIER_COMPLAINT'
  )!;

  const messagesAvailable = Array.isArray(order?.customerMessages);

  const messageTimesValid = messagesAvailable &&
    order.customerMessages.every((msg) =>
      Number.isFinite(new Date(msg.time).getTime())
    );

  const earlyComplaint =
    messagesAvailable && messageTimesValid && deliveryTime !== null
      ? order.customerMessages.some((msg) => {
          if (msg.from !== 'customer') return false;

          return new Date(msg.time).getTime() < deliveryTime;
        })
      : null;

  if (earlyComplaint === false) {
    totalScore += w3.points;
    breakdown.push({
      id: w3.id,
      title: w3.title,
      pointsPossible: w3.points,
      pointsAwarded: w3.points,
      passed: true,
      reason: 'No earlier customer complaint found in the available communication history.',
    });
  } else {
    breakdown.push({
      id: w3.id,
      title: w3.title,
      pointsPossible: w3.points,
      pointsAwarded: 0,
      passed: false,
      reason:
        earlyComplaint === null
          ? 'Communication history or valid delivery time is unavailable.'
          : 'Customer reported dissatisfaction before delivery.',
    });
  }

  // 4. Item photos or description evidence present (+20)
  const w4 = SNAD_RUBRIC_WEIGHTS.find(
    (w) => w.id === 'SNAD_EVIDENCE_PRESENT'
  )!;

  breakdown.push({
    id: w4.id,
    title: w4.title,
    pointsPossible: w4.points,
    pointsAwarded: 0,
    passed: false,
    reason:
      'Actual item-specific photos or condition evidence are unavailable for verification.',
  });

  // 5. No prior refund or goodwill offer (+10)
  const w5 = SNAD_RUBRIC_WEIGHTS.find(
    (w) => w.id === 'SNAD_NO_PRIOR_REFUND_OR_OFFER'
  )!;

  const refundHistoryAvailable = Array.isArray(order?.refunds);

  const hasPriorRefund = refundHistoryAvailable
    ? order.refunds.length > 0
    : null;

  if (hasPriorRefund === false) {
    totalScore += w5.points;
    breakdown.push({
      id: w5.id,
      title: w5.title,
      pointsPossible: w5.points,
      pointsAwarded: w5.points,
      passed: true,
      reason: 'No prior refunds recorded in the available order history.',
    });
  } else {
    breakdown.push({
      id: w5.id,
      title: w5.title,
      pointsPossible: w5.points,
      pointsAwarded: 0,
      passed: false,
      reason:
        hasPriorRefund === null
          ? 'Refund history is unavailable.'
          : 'A prior refund or settlement exists.',
    });
  }

  // 6. Delivery confirmed (+15)
  const w6 = SNAD_RUBRIC_WEIGHTS.find(
    (w) => w.id === 'SNAD_DELIVERY_CONFIRMED'
  )!;

  if (deliveryEvent) {
    totalScore += w6.points;
    breakdown.push({
      id: w6.id,
      title: w6.title,
      pointsPossible: w6.points,
      pointsAwarded: w6.points,
      passed: true,
      reason: `Carrier tracking records delivery at ${deliveryEvent.location || 'an unspecified location'}.`,
    });
  } else {
    breakdown.push({
      id: w6.id,
      title: w6.title,
      pointsPossible: w6.points,
      pointsAwarded: 0,
      passed: false,
      reason: 'A valid delivery event could not be verified.',
    });
  }

  // Calculate final score
  const band = getScoreBand(totalScore);

  return {
    totalScore,
    band,
    disputeReason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
    breakdown,
    summary: `Not As Described claim assessed at ${totalScore}/100 (${band.toUpperCase()} defense strength).`,
  };
}
