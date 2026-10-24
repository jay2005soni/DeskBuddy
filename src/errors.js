export class ApiError extends Error {
    status;
    code;
    constructor(status, code, message){
        super(message), this.status = status, this.code = code;
    }
}
export const unavailable = ()=>new ApiError(503, 'dependency_unavailable', 'Service temporarily unavailable. Please retry.');
export function providerCode(error) {
    return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
}
