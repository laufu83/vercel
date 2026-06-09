export function errorResponse(code: string, status: number, msg: string) {
  return { code, status, msg };
}

export function successResponse(data: any) {
  return { code: 200, data };
}