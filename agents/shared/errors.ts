export class BidDeadlineExpiredError extends Error {
  constructor(message = "Bid deadline has passed") {
    super(message);
    this.name = "BidDeadlineExpiredError";
  }
}

export class InsufficientCollateralError extends Error {
  constructor(message = "Insufficient collateral") {
    super(message);
    this.name = "InsufficientCollateralError";
  }
}

export class ContractCallError extends Error {
  constructor(message: string, public readonly originalError?: unknown) {
    super(message);
    this.name = "ContractCallError";
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
