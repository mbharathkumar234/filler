# Bench results

Written by `npm run bench` (`src/corpus/bench.run.ts`); how to read it: `bench/README.md`.

## The corpus — real forms

_No snapshots yet._

## The made-up fixtures — a regression check, not a measure of quality

| Set | Pages | Fields with a key | Correct | Correct, unflagged | Left empty | Wrong | Wrong, unflagged | Ambiguous | Unlabelled |
|---|---|---|---|---|---|---|---|---|---|
| bank-portal/bank-details | 1 | 11 | 100.0% | 100.0% | 0 | 0 | **0** | 0 | 0 |
| bench/01-aspnet-scholarship | 1 | 15 | 100.0% | 100.0% | 0 | 0 | **0** | 0 | 0 |
| bench/02-react-spa | 1 | 14 | 92.9% | 85.7% | 0 | 1 | **0** | 0 | 0 |
| bench/03-php-legacy | 1 | 13 | 100.0% | 100.0% | 0 | 0 | **0** | 0 | 0 |
| bench/04-google-form | 1 | 10 | 100.0% | 100.0% | 0 | 0 | **0** | 0 | 0 |
| bench/05-plain-html5 | 1 | 11 | 100.0% | 100.0% | 0 | 0 | **0** | 0 | 0 |
| bench/06-bootstrap-placeholder | 1 | 11 | 100.0% | 100.0% | 0 | 0 | **0** | 0 | 0 |
| bench/07-wizard-step3 | 1 | 9 | 100.0% | 66.7% | 0 | 0 | **0** | 0 | 0 |
| bench/08-bilingual-hindi | 1 | 12 | 100.0% | 100.0% | 0 | 0 | **0** | 0 | 0 |
| bench/09-table-grid | 1 | 11 | 63.6% | 63.6% | 4 | 0 | **0** | 0 | 0 |
| bench/10-shadow-components | 1 | 13 | 100.0% | 92.3% | 0 | 0 | **0** | 0 | 0 |
| certificate-portal/reservation | 1 | 9 | 100.0% | 100.0% | 0 | 0 | **0** | 0 | 0 |
| choice-portal/google-form | 1 | 7 | 100.0% | 85.7% | 0 | 0 | **0** | 0 | 0 |
| choice-portal/native-other | 1 | 6 | 100.0% | 100.0% | 0 | 0 | **0** | 0 | 0 |
| documents-portal/google-style | 1 | 0 | — | — | 0 | 0 | **0** | 0 | 0 |
| documents-portal/page-1 | 1 | 6 | 100.0% | 66.7% | 0 | 0 | **0** | 0 | 0 |
| documents-portal/student-documents | 1 | 73 | 100.0% | 97.3% | 0 | 0 | **0** | 0 | 0 |
| entrance-portal/page-1 | 1 | 13 | 100.0% | 100.0% | 0 | 0 | **0** | 0 | 0 |
| fourth-portal/page-1 | 1 | 27 | 48.1% | 22.2% | 11 | 3 | **0** | 0 | 0 |
| heldout-exam/page-1 | 1 | 23 | 100.0% | 100.0% | 0 | 1 | **0** | 0 | 0 |
| heldout-scholarship/page-1 | 1 | 29 | 100.0% | 96.6% | 0 | 0 | **0** | 0 | 0 |
| indic-portal/name-in-hindi | 1 | 5 | 100.0% | 80.0% | 0 | 0 | **0** | 0 | 0 |
| placement-portal/grades | 1 | 5 | 100.0% | 80.0% | 0 | 0 | **0** | 0 | 0 |
| **all** | 23 | 333 | 94.3% | 88.3% | 15 | 5 | **0** | 0 | 0 |

## Every mistake

- bench/02-react-spa: "Highest qualification institution" — filled as `education[].level` (0.78), should be `education[].institution`
- fourth-portal/page-1: "Name in which the Deposit Account stands" — filled as `identity.full_name` (0.8), should be `bank.account_holder`
- fourth-portal/page-1: "Deposit Account Numeral" — filled as `bank.account_type` (0.82), should be `bank.account_number`
- fourth-portal/page-1: "Name of the Banking Institution" — filled as `education[].institution` (0.78), should be `bank.bank_name`
- heldout-exam/page-1: "Examination Centre Preference 1" — filled as `education[].level` (0.82), should be `unknown`

## Left empty, by the key they should have had

- `education[].roll_number` × 1: "Rollno"
- `education[].marks_obtained` × 1: "Marks"
- `education[].max_marks` × 1: "Maxmarks"
- `education[].percentage` × 1: "Pct"
- `identity.dob` × 1: "Natal Date"
- `family.mother_name` × 1: "Name of Maternal Parent"
- `identity.category` × 1: "Reservation Stratum"
- `identity.marital_status` × 1: "Conjugal Status"
- `identity.blood_group` × 1: "Haemal Group"
- `address.permanent.line1` × 1: "Premises Number and Thoroughfare"
- `address.permanent.city` × 1: "Urban Agglomeration"
- `address.permanent.district` × 1: "Revenue Division"
- `address.permanent.pincode` × 1: "Postal Index Number"
- `id.aadhaar` × 1: "Unique Identification Authority Number"
- `id.voter` × 1: "Electoral Photo Identity Number"

