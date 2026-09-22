export abstract class DomainException extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class EmailAlreadyExistsException extends DomainException {
  constructor() {
    super('EMAIL_ALREADY_EXISTS', 409, 'Email is already registered');
  }
}

export class InvalidCredentialsException extends DomainException {
  constructor() {
    super('INVALID_CREDENTIALS', 401, 'Invalid email or password');
  }
}

export class EmailNotConfirmedException extends DomainException {
  constructor() {
    super('EMAIL_NOT_CONFIRMED', 403, 'Email address has not been confirmed');
  }
}

export class InvalidTokenException extends DomainException {
  constructor() {
    super('INVALID_TOKEN', 401, 'Token is invalid');
  }
}

export class TokenExpiredException extends DomainException {
  constructor() {
    super('TOKEN_EXPIRED', 401, 'Token has expired');
  }
}

export class TokenReuseDetectedException extends DomainException {
  constructor() {
    super(
      'TOKEN_REUSE_DETECTED',
      401,
      'Token reuse detected — all sessions revoked',
    );
  }
}

export class VideoUploadTooLargeException extends DomainException {
  constructor() {
    super('UPLOAD_TOO_LARGE', 413, 'File size exceeds the 10 GiB limit');
  }
}

export class UnsupportedVideoContentTypeException extends DomainException {
  constructor() {
    super(
      'UNSUPPORTED_MEDIA_TYPE',
      415,
      'Content type is not among the accepted video formats',
    );
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class InvalidPartNumberException extends DomainException {
  constructor() {
    super(
      'INVALID_PART_NUMBER',
      400,
      'Part number is outside the valid range for this upload',
    );
  }
}

export class UploadNotInProgressException extends DomainException {
  constructor() {
    super(
      'UPLOAD_NOT_IN_PROGRESS',
      409,
      'The upload is not currently in progress',
    );
  }
}

export class UploadIncompleteException extends DomainException {
  constructor() {
    super(
      'UPLOAD_INCOMPLETE',
      422,
      'Uploaded parts do not match the expected upload',
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video has not finished processing yet');
  }
}
