// src/bulkCustomers.ts
//
// Raw customer data for the manual/bulk Highmark import batch. Kept as its
// own file (not inline in the seeding script) so the data can be swapped
// out for a future batch without touching the seeding logic itself.

export interface RawBulkCustomer {
    firstName: string;
    lastName: string;
    dob: string; // DD/MM/YYYY
    fatherName: string;
    identifierType: "pan" | "ckyc";
    identifierValue: string; // PAN or CKYC number
    addressLocality: string;
    addressLine1: string;
    addressPinCode: string;
    mobile?: string; // may be missing or empty — PAN is the fallback join/ID key
}

export const bulkCustomers: RawBulkCustomer[] = [
   
  {
    firstName: "Bipin",
    lastName: "Murmu",
    dob: "02/03/2000",
    fatherName: "Raidas Murmu",
    identifierType: "pan",
    identifierValue: "JDRPM8802B",
    addressLocality: "Samukanendi",
    addressLine1: "Samukanendi",
    addressPinCode: "758025",
    mobile: "9692117114"
  },
  {
    firstName: "Subarnamani",
    lastName: "Majhi",
    dob: "16/01/1999",
    fatherName: "Hikim Majhi",
    identifierType: "pan",
    identifierValue: "HHFPM7650K",
    addressLocality: "Saria",
    addressLine1: "Saria",
    addressPinCode: "757100",
    mobile: "9348576968"
  }

];

console.log(bulkCustomers.length)