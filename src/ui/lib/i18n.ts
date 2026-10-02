/**
 * UI localisation (§ COMPLETION_PLAN Phase F, Should Achieve).
 *
 *   "UI localisation (Hindi + one regional language)."
 *
 * ## Why not `chrome.i18n`
 *
 * The platform's own `_locales/` mechanism is the obvious choice and it is the
 * wrong one here. It resolves against the *browser's* UI language, which for
 * most of this product's users is English regardless of what they read most
 * comfortably — a shared machine, a cybercafé, a phone-shop install. Somebody
 * filling a scholarship form in Devanagari should be able to choose that
 * without reinstalling Chrome in Hindi. So the language is a setting, stored
 * with the extension, defaulting to the browser's when it is one we have.
 *
 * `chrome.i18n` is also unavailable in a plain test, which would put every
 * string in the panel behind a browser mock.
 *
 * ## The shape
 *
 * `MESSAGES` is the English catalogue and its type *is* the contract: every
 * other locale is `Record<MessageKey, string>`, so a missing key is a type
 * error rather than a blank label discovered by a user. `i18n.test.ts` also
 * asserts it at runtime, because a translation added through JSON or a cast
 * would slip past the compiler.
 *
 * ## What is and is not translated
 *
 * The panel's own words are. Field *labels read off the portal's page* are not
 * — they are the portal's text, and rewriting them would mean the review screen
 * showed something different from the form behind it, which is precisely what
 * a review screen must never do.
 */

export const MESSAGES = {
  // -- Disclosure ---------------------------------------------------------
  'disclosure.heading': 'Before you start',
  'disclosure.what.heading': 'What this does',
  'disclosure.leaves.heading': 'What leaves this device',
  'disclosure.verify.heading': 'What you must check',
  'disclosure.responsible.heading': 'You are responsible',
  'disclosure.what.body':
    'You save your details once, encrypted on this device. When you press Fill on a form, it types them in for you and then stops, so you can check every value before anything is sent.',
  'disclosure.leaves.body':
    'Nothing, unless you add your own API key for the optional field-identification helper. If you do, it is sent the shape of a form — labels and field names, with anything value-like stripped out and checked against your own details first. Your saved details, your documents, and the address of the page are never sent.',
  'disclosure.wont.heading': 'What it will not do',
  'disclosure.wont.submit': 'Submit a form without your explicit approval.',
  'disclosure.wont.captcha': 'Read or solve a CAPTCHA, or read a one-time code.',
  'disclosure.wont.sign': 'Sign anything electronically, or make a payment.',
  'disclosure.wont.password': 'Fill a password.',
  'disclosure.wont.body': 'When a form reaches one of those, it stops and hands the page back to you.',
  'disclosure.responsible.lead': 'The accuracy of anything you submit.',
  'disclosure.responsible.body':
    'This software types faster than you do; it does not know whether your details are correct, whether you are eligible, or whether a form means what you think it means. Check the review screen before you approve — that is what it is for.',
  'disclosure.responsible.recovery':
    'There is no password recovery. If you forget your passphrase, your saved details are gone. Export a backup and keep it somewhere safe.',
  'disclosure.accept': 'I understand',

  // -- Vault gate ---------------------------------------------------------
  'vault.create.heading': 'Create your vault',
  'vault.unlock.heading': 'Unlock your vault',
  'vault.passphrase': 'Passphrase',
  'vault.passphrase.confirm': 'Confirm passphrase',
  'vault.create.action': 'Create vault',
  'vault.unlock.action': 'Unlock',
  'vault.noReset': 'Nobody can reset this for you. If you forget it, your details are gone.',

  // -- Getting started ----------------------------------------------------
  'onboarding.heading': 'Getting set up',
  'onboarding.progress': '{done} of {total} done',
  'onboarding.step.done': ' — done',
  'onboarding.step.todo': ' — not done yet',
  'onboarding.hide': 'Hide this',
  'onboarding.openPractice': 'Open the practice form',
  'onboarding.addDetails': 'Add my details',
  'onboarding.uploadPhoto': 'Upload a photo',
  'onboarding.detailsSaved': '{at} of {of} details saved',
  'onboarding.uploaded': '{at} uploaded',

  'step.vault.title': 'Create your vault',
  'step.vault.detail': 'One passphrase, encrypted on this device. Nobody can reset it for you.',
  'step.path.title': 'Say what you have studied',
  'step.path.detail':
    'Your board, your stream and where you are now. The vault is built from this, so you ' +
    'only see the blocks and documents you actually have.',
  'step.profile.title': 'Add your details',
  'step.profile.detail':
    'Name, date of birth, contact and address — the ones every portal asks for.',
  'step.documents.title': 'Upload your photo and signature',
  'step.documents.detail':
    'Checked for size and dimensions now, so a portal does not reject them later.',
  'step.firstFill.title': 'Try a fill on the practice form',
  'step.firstFill.detail':
    'A local page, so nothing is submitted anywhere. See what review looks like first.',

  'onboarding.unusable.one':
    'One uploaded file is too small or the wrong shape for a portal to accept. Open your documents to see what to change.',
  'onboarding.unusable.many':
    '{count} uploaded files are too small or the wrong shape for a portal to accept. Open your documents to see what to change.',

  // -- Review -------------------------------------------------------------
  'review.heading': 'Check before you submit',
  'review.approve': 'Hold to approve and submit',
  'review.holdToConfirm': 'Keep holding…',
  'review.cancel': 'Cancel',
  'review.flagged.heading': 'Check these first',
  'review.flagged.tick': 'I have checked this',
  'review.blocked':
    'Some fields still need checking. Tick each one above before you can approve.',
  'review.notSubmitted': 'Nothing has been submitted yet.',
  'review.unmapped': 'Left blank — no match',

  // -- Language picker ----------------------------------------------------
  'language.label': 'Language',
} as const;

export type MessageKey = keyof typeof MESSAGES;
export type Catalogue = Readonly<Record<MessageKey, string>>;

/**
 * The locales this ships with.
 *
 * Hindi and Tamil: the plan asks for "Hindi + one regional language", and Tamil
 * is the one whose portal users are least likely to be served by Hindi — a
 * regional language that is a genuine second option rather than a near-synonym
 * for the first.
 *
 * These translations were produced during development and have **not been
 * reviewed by a native speaker**. That is recorded in `STATUS.md` rather than
 * hidden, because a consent screen or an approval button that reads oddly is
 * worse than one in a language the reader merely finds harder. Do not treat
 * these as finished copy.
 */
export const LOCALES = ['en', 'hi', 'ta'] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_NAMES: Readonly<Record<Locale, string>> = {
  en: 'English',
  hi: 'हिन्दी',
  ta: 'தமிழ்',
};

const HI: Catalogue = {
  'disclosure.heading': 'शुरू करने से पहले',
  'disclosure.what.heading': 'यह क्या करता है',
  'disclosure.leaves.heading': 'इस डिवाइस से क्या बाहर जाता है',
  'disclosure.verify.heading': 'आपको क्या जाँचना है',
  'disclosure.responsible.heading': 'ज़िम्मेदारी आपकी है',
  'disclosure.what.body':
    'आप अपना विवरण एक बार सहेजते हैं, जो इसी डिवाइस पर एन्क्रिप्ट होकर रहता है। जब आप किसी फ़ॉर्म पर भरें दबाते हैं, तो यह आपके लिए विवरण भर देता है और फिर रुक जाता है, ताकि कुछ भी भेजे जाने से पहले आप हर मान जाँच सकें।',
  'disclosure.leaves.body':
    'कुछ भी नहीं, जब तक आप वैकल्पिक फ़ील्ड-पहचान सहायक के लिए अपनी API कुंजी न जोड़ें। यदि आप जोड़ते हैं, तो उसे फ़ॉर्म का केवल ढाँचा भेजा जाता है — लेबल और फ़ील्ड के नाम, जिनमें से मान जैसी हर चीज़ हटा दी जाती है और पहले आपके अपने विवरण से जाँच ली जाती है। आपका सहेजा गया विवरण, आपके दस्तावेज़ और पेज का पता कभी नहीं भेजे जाते।',
  'disclosure.wont.heading': 'यह क्या नहीं करेगा',
  'disclosure.wont.submit': 'आपकी स्पष्ट मंज़ूरी के बिना कोई फ़ॉर्म जमा नहीं करेगा।',
  'disclosure.wont.captcha': 'CAPTCHA पढ़ेगा या हल नहीं करेगा, और न ही कोई OTP पढ़ेगा।',
  'disclosure.wont.sign': 'कुछ भी इलेक्ट्रॉनिक रूप से हस्ताक्षरित नहीं करेगा, न कोई भुगतान करेगा।',
  'disclosure.wont.password': 'कोई पासवर्ड नहीं भरेगा।',
  'disclosure.wont.body':
    'जब कोई फ़ॉर्म इनमें से किसी पर पहुँचता है, तो यह रुक जाता है और पेज आपको वापस सौंप देता है।',
  'disclosure.responsible.lead': 'आप जो कुछ भी जमा करते हैं उसकी सटीकता।',
  'disclosure.responsible.body':
    'यह सॉफ़्टवेयर आपसे तेज़ टाइप करता है; इसे यह नहीं पता कि आपका विवरण सही है या नहीं, आप पात्र हैं या नहीं, या फ़ॉर्म का वही अर्थ है जो आप समझते हैं। मंज़ूरी देने से पहले समीक्षा स्क्रीन जाँचें — वह इसी के लिए है।',
  'disclosure.responsible.recovery':
    'पासवर्ड वापस पाने का कोई तरीका नहीं है। यदि आप अपना पासफ़्रेज़ भूल गए, तो आपका सहेजा गया विवरण चला जाएगा। बैकअप निर्यात करके किसी सुरक्षित जगह रखें।',
  'disclosure.accept': 'मैं समझ गया',

  'vault.create.heading': 'अपना वॉल्ट बनाएँ',
  'vault.unlock.heading': 'अपना वॉल्ट खोलें',
  'vault.passphrase': 'पासफ़्रेज़',
  'vault.passphrase.confirm': 'पासफ़्रेज़ दोबारा लिखें',
  'vault.create.action': 'वॉल्ट बनाएँ',
  'vault.unlock.action': 'खोलें',
  'vault.noReset': 'इसे कोई भी रीसेट नहीं कर सकता। भूल गए तो आपका विवरण चला जाएगा।',

  'onboarding.heading': 'सेटअप',
  'onboarding.progress': '{total} में से {done} पूरे',
  'onboarding.step.done': ' — पूरा',
  'onboarding.step.todo': ' — अभी बाकी है',
  'onboarding.hide': 'इसे छिपाएँ',
  'onboarding.openPractice': 'अभ्यास फ़ॉर्म खोलें',
  'onboarding.addDetails': 'मेरा विवरण जोड़ें',
  'onboarding.uploadPhoto': 'फ़ोटो अपलोड करें',
  'onboarding.detailsSaved': '{of} में से {at} विवरण सहेजे गए',
  'onboarding.uploaded': '{at} अपलोड हुए',

  'step.vault.title': 'अपना वॉल्ट बनाएँ',
  'step.vault.detail':
    'एक पासफ़्रेज़, इसी डिवाइस पर एन्क्रिप्ट किया हुआ। इसे कोई भी रीसेट नहीं कर सकता।',
  'step.path.title': 'आपने क्या पढ़ा है, यह बताएँ',
  'step.path.detail':
    'आपका बोर्ड, स्ट्रीम और अभी आप कहाँ हैं — वॉल्ट इसी से बनता है, ताकि आपको ' +
    'वही दिखे जो वाकई आपके पास है।',
  'step.profile.title': 'अपना विवरण जोड़ें',
  'step.profile.detail': 'नाम, जन्मतिथि, संपर्क और पता — जो हर पोर्टल माँगता है।',
  'step.documents.title': 'अपनी फ़ोटो और हस्ताक्षर अपलोड करें',
  'step.documents.detail':
    'आकार और माप अभी जाँच लिए जाते हैं, ताकि बाद में कोई पोर्टल इन्हें अस्वीकार न करे।',
  'step.firstFill.title': 'अभ्यास फ़ॉर्म पर भरकर देखें',
  'step.firstFill.detail':
    'यह पेज इसी डिवाइस पर है, कहीं कुछ जमा नहीं होता। पहले देखिए कि समीक्षा कैसी दिखती है।',

  'onboarding.unusable.one':
    'एक अपलोड की गई फ़ाइल बहुत छोटी है या उसका आकार पोर्टल के लिए सही नहीं है। बदलाव देखने के लिए अपने दस्तावेज़ खोलें।',
  'onboarding.unusable.many':
    '{count} अपलोड की गई फ़ाइलें बहुत छोटी हैं या उनका आकार पोर्टल के लिए सही नहीं है। बदलाव देखने के लिए अपने दस्तावेज़ खोलें।',

  'review.heading': 'जमा करने से पहले जाँचें',
  'review.approve': 'मंज़ूरी देकर जमा करने के लिए दबाए रखें',
  'review.holdToConfirm': 'दबाए रखें…',
  'review.cancel': 'रद्द करें',
  'review.flagged.heading': 'इन्हें पहले जाँचें',
  'review.flagged.tick': 'मैंने इसे जाँच लिया है',
  'review.blocked':
    'कुछ फ़ील्ड अभी जाँचने बाकी हैं। मंज़ूरी देने से पहले ऊपर हर एक पर निशान लगाएँ।',
  'review.notSubmitted': 'अभी कुछ भी जमा नहीं हुआ है।',
  'review.unmapped': 'खाली छोड़ा गया — कोई मिलान नहीं',

  'language.label': 'भाषा',
};

const TA: Catalogue = {
  'disclosure.heading': 'தொடங்குவதற்கு முன்',
  'disclosure.what.heading': 'இது என்ன செய்கிறது',
  'disclosure.leaves.heading': 'இந்தச் சாதனத்தை விட்டு என்ன வெளியே செல்கிறது',
  'disclosure.verify.heading': 'நீங்கள் சரிபார்க்க வேண்டியவை',
  'disclosure.responsible.heading': 'பொறுப்பு உங்களுடையது',
  'disclosure.what.body':
    'உங்கள் விவரங்களை ஒரு முறை சேமிக்கிறீர்கள், அவை இந்தச் சாதனத்திலேயே மறையாக்கப்பட்டு இருக்கும். ஒரு படிவத்தில் நிரப்பு என்பதை அழுத்தும்போது, அது உங்களுக்காக அவற்றைத் தட்டச்சு செய்துவிட்டு நின்றுவிடும் — எதுவும் அனுப்பப்படுவதற்கு முன் ஒவ்வொரு மதிப்பையும் நீங்கள் சரிபார்க்கலாம்.',
  'disclosure.leaves.body':
    'எதுவும் இல்லை — விருப்பத் தேர்வான புலம்-அடையாளக் காணும் உதவிக்காக உங்கள் சொந்த API சாவியைச் சேர்த்தால் தவிர. சேர்த்தால், படிவத்தின் அமைப்பு மட்டுமே அனுப்பப்படும் — சிட்டைகளும் புலப் பெயர்களும், மதிப்பு போலத் தோன்றும் அனைத்தும் நீக்கப்பட்டு, முதலில் உங்கள் சொந்த விவரங்களுடன் சரிபார்க்கப்பட்ட பிறகு. உங்கள் சேமித்த விவரங்கள், உங்கள் ஆவணங்கள், பக்கத்தின் முகவரி — இவை ஒருபோதும் அனுப்பப்படுவதில்லை.',
  'disclosure.wont.heading': 'இது என்ன செய்யாது',
  'disclosure.wont.submit': 'உங்கள் வெளிப்படையான ஒப்புதல் இல்லாமல் எந்தப் படிவத்தையும் சமர்ப்பிக்காது.',
  'disclosure.wont.captcha': 'CAPTCHA-வைப் படிக்காது, தீர்க்காது; ஒருமுறைக் குறியீட்டையும் படிக்காது.',
  'disclosure.wont.sign': 'எதற்கும் மின்னணுக் கையொப்பம் இடாது, பணம் செலுத்தாது.',
  'disclosure.wont.password': 'கடவுச்சொல்லை நிரப்பாது.',
  'disclosure.wont.body':
    'ஒரு படிவம் இவற்றில் ஒன்றை அடையும்போது, அது நின்று பக்கத்தை உங்களிடமே திருப்பித் தந்துவிடும்.',
  'disclosure.responsible.lead': 'நீங்கள் சமர்ப்பிக்கும் எதன் சரியான தன்மையும்.',
  'disclosure.responsible.body':
    'இந்த மென்பொருள் உங்களைவிட வேகமாகத் தட்டச்சு செய்யும்; உங்கள் விவரங்கள் சரியா, நீங்கள் தகுதியானவரா, படிவத்தின் பொருள் நீங்கள் நினைப்பதுதானா என்பது இதற்குத் தெரியாது. ஒப்புதல் அளிக்கும் முன் மறுபார்வைத் திரையைச் சரிபாருங்கள் — அதற்குத்தான் அது.',
  'disclosure.responsible.recovery':
    'கடவுச்சொல்லை மீட்க வழி இல்லை. உங்கள் கடவுச்சொற்றொடரை மறந்தால், சேமித்த விவரங்கள் போய்விடும். ஒரு காப்புப் பிரதியை ஏற்றுமதி செய்து பாதுகாப்பான இடத்தில் வையுங்கள்.',
  'disclosure.accept': 'புரிந்தது',

  'vault.create.heading': 'உங்கள் பெட்டகத்தை உருவாக்குங்கள்',
  'vault.unlock.heading': 'உங்கள் பெட்டகத்தைத் திறங்கள்',
  'vault.passphrase': 'கடவுச்சொற்றொடர்',
  'vault.passphrase.confirm': 'கடவுச்சொற்றொடரை மீண்டும் உள்ளிடுங்கள்',
  'vault.create.action': 'பெட்டகத்தை உருவாக்கு',
  'vault.unlock.action': 'திற',
  'vault.noReset':
    'இதை யாராலும் மீட்டமைக்க முடியாது. மறந்துவிட்டால் உங்கள் விவரங்கள் போய்விடும்.',

  'onboarding.heading': 'அமைவு',
  'onboarding.progress': '{total} இல் {done} முடிந்தது',
  'onboarding.step.done': ' — முடிந்தது',
  'onboarding.step.todo': ' — இன்னும் முடியவில்லை',
  'onboarding.hide': 'இதை மறை',
  'onboarding.openPractice': 'பயிற்சிப் படிவத்தைத் திற',
  'onboarding.addDetails': 'என் விவரங்களைச் சேர்',
  'onboarding.uploadPhoto': 'புகைப்படத்தைப் பதிவேற்று',
  'onboarding.detailsSaved': '{of} இல் {at} விவரங்கள் சேமிக்கப்பட்டன',
  'onboarding.uploaded': '{at} பதிவேற்றப்பட்டன',

  'step.vault.title': 'உங்கள் பெட்டகத்தை உருவாக்குங்கள்',
  'step.vault.detail':
    'ஒரு கடவுச்சொற்றொடர், இந்தச் சாதனத்திலேயே மறையாக்கப்படும். இதை யாராலும் மீட்டமைக்க முடியாது.',
  'step.path.title': 'நீங்கள் என்ன படித்தீர்கள் என்பதைச் சொல்லுங்கள்',
  'step.path.detail':
    'உங்கள் வாரியம், பிரிவு, இப்போது நீங்கள் எங்கே இருக்கிறீர்கள் என்பது. இதிலிருந்தே ' +
    'பெட்டகம் உருவாகிறது; உங்களிடம் உள்ளவை மட்டுமே காட்டப்படும்.',
  'step.profile.title': 'உங்கள் விவரங்களைச் சேர்க்கவும்',
  'step.profile.detail':
    'பெயர், பிறந்த தேதி, தொடர்பு மற்றும் முகவரி — ஒவ்வொரு போர்ட்டலும் கேட்பவை.',
  'step.documents.title': 'உங்கள் புகைப்படத்தையும் கையொப்பத்தையும் பதிவேற்றுங்கள்',
  'step.documents.detail':
    'அளவும் பரிமாணமும் இப்போதே சரிபார்க்கப்படும், பின்னர் ஒரு போர்ட்டல் இவற்றை நிராகரிக்காமல் இருக்க.',
  'step.firstFill.title': 'பயிற்சிப் படிவத்தில் நிரப்பிப் பாருங்கள்',
  'step.firstFill.detail':
    'இது இந்தச் சாதனத்திலுள்ள பக்கம், எங்கும் எதுவும் சமர்ப்பிக்கப்படாது. மறுபார்வை எப்படி இருக்கும் என்பதை முதலில் பாருங்கள்.',

  'onboarding.unusable.one':
    'பதிவேற்றப்பட்ட ஒரு கோப்பு மிகச் சிறியது அல்லது போர்ட்டல் ஏற்கும் வடிவத்தில் இல்லை. என்ன மாற்ற வேண்டும் என்பதைப் பார்க்க உங்கள் ஆவணங்களைத் திறங்கள்.',
  'onboarding.unusable.many':
    'பதிவேற்றப்பட்ட {count} கோப்புகள் மிகச் சிறியவை அல்லது போர்ட்டல் ஏற்கும் வடிவத்தில் இல்லை. என்ன மாற்ற வேண்டும் என்பதைப் பார்க்க உங்கள் ஆவணங்களைத் திறங்கள்.',

  'review.heading': 'சமர்ப்பிக்கும் முன் சரிபாருங்கள்',
  'review.approve': 'ஒப்புதல் அளித்துச் சமர்ப்பிக்க அழுத்திப் பிடியுங்கள்',
  'review.holdToConfirm': 'பிடித்திருங்கள்…',
  'review.cancel': 'ரத்து செய்',
  'review.flagged.heading': 'இவற்றை முதலில் சரிபாருங்கள்',
  'review.flagged.tick': 'இதை நான் சரிபார்த்துவிட்டேன்',
  'review.blocked':
    'சில புலங்கள் இன்னும் சரிபார்க்கப்பட வேண்டும். ஒப்புதல் அளிக்கும் முன் மேலே ஒவ்வொன்றையும் குறியிடுங்கள்.',
  'review.notSubmitted': 'இதுவரை எதுவும் சமர்ப்பிக்கப்படவில்லை.',
  'review.unmapped': 'காலியாக விடப்பட்டது — பொருத்தம் இல்லை',

  'language.label': 'மொழி',
};

export const CATALOGUES: Readonly<Record<Locale, Catalogue>> = {
  en: MESSAGES,
  hi: HI,
  ta: TA,
};

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/**
 * Fill `{name}` placeholders.
 *
 * Word order differs between these languages — Hindi puts the total before the
 * count in "3 of 4 done" — so the catalogue has to be able to move the
 * placeholders around, which rules out positional formatting.
 */
export function format(template: string, vars?: Readonly<Record<string, string | number>>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/**
 * Look a message up, falling back to English.
 *
 * The fallback exists for a locale added with a gap in it. The test suite makes
 * that a build failure, so in a shipped build this branch is unreachable — but
 * a missing key must degrade to readable English, never to a blank control with
 * no accessible name.
 */
export function translate(
  locale: Locale,
  key: MessageKey,
  vars?: Readonly<Record<string, string | number>>,
): string {
  const text = CATALOGUES[locale][key] || MESSAGES[key];
  return format(text, vars);
}

/** The locale to use when the user has not chosen one. */
export function preferredLocale(uiLanguage: string | undefined): Locale {
  const base = (uiLanguage ?? 'en').toLowerCase().split('-')[0] ?? 'en';
  return isLocale(base) ? base : 'en';
}
