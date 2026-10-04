# Corpus candidates (U0.M2, `MASTER_PROMPT.md`)

Forms that could be captured for the corpus, by category, for the human to decide on. Nothing here
has been captured, and nothing may be until its verdict is recorded: a terms-of-service verdict is a
human's judgement (`README.md` in this folder), written as a note from `TEMPLATE.md`.

How to use this list:

1. Read the site's terms of use. Record `assistive-ok`, `unclear` or `prohibited` in a note named
   after the site, and in the **Verdict** column below.
2. For `assistive-ok` only: `npm run capture -- <address> --category <category> --name <name> --stack <stack> [--login]`.
   Bring the form on screen (logged in if it needs it, typing nothing), then press Enter.
3. Read the snapshot before committing it — a logged-in page can show your name as plain text —
   and run `npm run scan-values`.

Addresses are where each portal is commonly found; confirm each one before capturing. A form behind a
login can only be captured by you, on your own account. Prefer a portal's first public page (new
registration, eligibility check) where one exists.

Corpus minimums: scholarships 25, entrance 20, banking 10, jobs 15, travel 5, everyday 15,
form-builders 5, legacy 5 — at least 100 in all.

## Scholarships and welfare schemes (25)

| Portal | Address | Login | Verdict |
|---|---|---|---|
| National Scholarship Portal | scholarships.gov.in | registration public; application after login | — |
| Karnataka State Scholarship Portal (SSP) | ssp.karnataka.gov.in | yes | — |
| Maharashtra MahaDBT | mahadbt.maharashtra.gov.in | registration public | — |
| Telangana ePASS | telanganaepass.cgg.gov.in | registration public | — |
| Andhra Pradesh Jnanabhumi | jnanabhumi.ap.gov.in | yes | — |
| Uttar Pradesh scholarship | scholarship.up.gov.in | registration public | — |
| Bihar post-matric scholarship | pmsonline.bih.nic.in | registration public | — |
| West Bengal OASIS | oasis.gov.in | registration public | — |
| Kerala e-Grantz | egrantz.kerala.gov.in | yes | — |
| Rajasthan SJE scholarships | sje.rajasthan.gov.in | via SSO | — |
| Madhya Pradesh Scholarship Portal | scholarshipportal.mp.nic.in | registration public | — |
| Odisha State Scholarship Portal | scholarship.odisha.gov.in | registration public | — |
| Punjab scholarship portal | scholarships.punjab.gov.in | registration public | — |
| Haryana scholarship portal | harchhatravratti.highereduhry.ac.in | registration public | — |
| Digital Gujarat scholarships | digitalgujarat.gov.in | registration public | — |
| Tamil Nadu scholarship (e-District / umis) | (confirm current address) | — | — |
| Buddy4Study (private scholarships) | buddy4study.com | registration public | — |
| Vidyasaarathi | vidyasaarathi.co.in | registration public | — |
| HDFC / Tata / Reliance foundation scholarships (via their application forms) | (per scheme) | varies | — |
| A university's own fee-waiver or merit-scholarship form | (per university) | varies | — |

## Entrance exams and admissions (20)

| Portal | Address | Login | Verdict |
|---|---|---|---|
| JEE Main (NTA) | jeemain.nta.nic.in | registration public | — |
| NEET UG (NTA) | neet.nta.nic.in | registration public | — |
| CUET UG (NTA) | cuet.nta.nic.in | registration public | — |
| KCET (Karnataka Examinations Authority) | cetonline.karnataka.gov.in | registration public | — |
| COMEDK UGET | comedk.org | registration public | — |
| MHT CET | cetcell.mahacet.org | registration public | — |
| AP EAPCET | cets.apsche.ap.gov.in | registration public | — |
| TS EAPCET | eapcet.tsche.ac.in | registration public | — |
| BITSAT | bitsadmission.com | registration public | — |
| VITEEE | vit.ac.in | registration public | — |
| GATE | (the organising IIT's site for the year) | registration public | — |
| CAT | iimcat.ac.in | registration public | — |
| CLAT | consortiumofnlus.ac.in | registration public | — |
| JoSAA counselling | josaa.nic.in | yes | — |
| Delhi University admissions (CSAS) | admission.uod.ac.in | registration public | — |
| IGNOU admissions | ignouadmission.samarth.edu.in | registration public | — |
| A state's polytechnic or PUC admission form | (per state) | varies | — |

## Banking, KYC and insurance (10)

| Portal | Address | Login | Verdict |
|---|---|---|---|
| A bank's account-opening or lead form (SBI, Canara, Karnataka Bank, HDFC) | (per bank) | often OTP-gated — capture only the first public page | — |
| Mutual-fund KYC (CAMS / KFintech) | (per registrar) | varies | — |
| LIC customer portal registration | licindia.in | registration public | — |
| Post office savings / India Post Payments Bank | ippbonline.com | varies | — |
| A general-insurance quote form | (per insurer) | public | — |

## Job applications (15)

| Portal | Address | Login | Verdict |
|---|---|---|---|
| A company careers page on Workday | (per company) | account step | — |
| A company job board on Greenhouse | boards.greenhouse.io/<company> | public | — |
| A company job board on Lever | jobs.lever.co/<company> | public | — |
| SmartRecruiters / iCIMS / Taleo careers pages | (per company) | varies | — |
| Naukri registration | naukri.com | registration public | — |
| Internshala registration | internshala.com | registration public | — |
| SSC one-time registration | ssc.gov.in | registration public | — |
| UPSC online application | upsconline.nic.in | registration public | — |
| IBPS registration | ibps.in | registration public | — |
| A college's campus-placement registration form | (per college) | yes | — |

## Passport, visa and travel (5)

| Portal | Address | Login | Verdict |
|---|---|---|---|
| Passport Seva registration | passportindia.gov.in | registration public | — |
| IRCTC registration | irctc.co.in | registration public | — |
| A state transport bus-pass application | (per state) | varies | — |
| A foreign-university or visa application form a student uses | (per country) | varies | — |

## Everyday web forms (15)

| Portal | Address | Login | Verdict |
|---|---|---|---|
| CPGRAMS public grievance | pgportal.gov.in | registration public | — |
| RTI online | rtionline.gov.in | public | — |
| An open-source shop's checkout demo (WooCommerce, Magento) | (demo site) | public | — |
| A utility's new-connection or complaint form | (per utility) | varies | — |
| Sign-up, contact and address forms on sites the human uses | (per site) | varies | — |

## Form builders (5)

| Portal | Address | Login | Verdict |
|---|---|---|---|
| Google Forms (a public form) | docs.google.com/forms | public | — |
| Microsoft Forms (a public form) | forms.office.com | public | — |
| Typeform, Jotform, Zoho Forms (public templates) | (per builder) | public | — |

## Legacy stacks (5)

| Portal | Address | Login | Verdict |
|---|---|---|---|
| An older state portal on ASP.NET WebForms (view state, postbacks) | (per state) | varies | — |
| A college admission form in PHP | (per college) | varies | — |
| A jQuery-era registration form | (per site) | varies | — |
