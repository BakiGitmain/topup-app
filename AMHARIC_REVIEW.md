# Amharic review

Amharic is the app's default language. Everything below was written by Claude, not a native speaker, so please read it.

## 1. Still ENGLISH in the app, waiting for your approval (20)

These are the sentences where a wrong word can cost someone money (how to pay, what a mismatch means, what a withdrawal does), so they stay English until you approve them. My draft is in the last column: correct it, or tell me "approved" and I will swap it in.

| Key | English (shown today) | Draft Amharic |
|---|---|---|
| `pay.noAccount` | This payment method is not available yet. Try the other one, or contact support. | ይህ የመክፈያ መንገድ ገና አይገኝም። ሌላውን ይሞክሩ ወይም ድጋፍን ያግኙ። |
| `pay.steps.telebirr` | Send the amount above by Telebirr to this number, then enter the transaction number from your receipt below. | ከላይ ያለውን መጠን በቴሌብር ወደዚህ ቁጥር ይላኩ፣ ከዚያ ከደረሰኝዎ የግብይት ቁጥሩን ከታች ያስገቡ። |
| `pay.steps.cbe` | Send the amount above to this CBE account, then enter the transaction ID from your receipt below (it starts with FT). | ከላይ ያለውን መጠን ወደዚህ የCBE መለያ ይላኩ፣ ከዚያ ከደረሰኝዎ የግብይት መለያ ቁጥሩን ከታች ያስገቡ (በFT ይጀምራል)። |
| `pay.mismatchBody` | We found your transfer, but its amount doesn't match this order ({amount}). We're looking into it, so please don't pay again. Contact support if you need help. | ዝውውርዎን አግኝተነዋል፣ ነገር ግን መጠኑ ከዚህ ትዕዛዝ ({amount}) ጋር አይመሳሰልም። እየተመለከትነው ነው፤ እባክዎ እንደገና አይክፈሉ። እርዳታ ከፈለጉ ድጋፍን ያግኙ። |
| `pay.notVerified.not_found` | We couldn't find that payment. Check the reference and try again. | ያንን ክፍያ ማግኘት አልተቻለም። የግብይት ቁጥሩን ያረጋግጡና እንደገና ይሞክሩ። |
| `pay.notVerified.provider_mismatch` | That doesn't look like a payment to our account with this method. Check the method and the reference. | ይህ በዚህ መንገድ ወደ መለያችን የተደረገ ክፍያ አይመስልም። የመክፈያ መንገዱንና የግብይት ቁጥሩን ያረጋግጡ። |
| `pay.notVerified.pending` | Your payment isn't confirmed yet. Wait a minute and try again. | ክፍያዎ ገና አልተረጋገጠም። ትንሽ ይጠብቁና እንደገና ይሞክሩ። |
| `pay.notVerified.invalid_request` | That reference doesn't look right. Check it and try again. | ይህ የግብይት ቁጥር ትክክል አይመስልም። ያረጋግጡና እንደገና ይሞክሩ። |
| `pay.notVerified.unknown` | We couldn't confirm that payment. Check the reference and try again. | ያንን ክፍያ ማረጋገጥ አልተቻለም። የግብይት ቁጥሩን ያረጋግጡና እንደገና ይሞክሩ። |
| `pay.referenceUsed` | That reference was already used for another order. Enter the reference of the payment you made for THIS order. | ይህ የግብይት ቁጥር ለሌላ ትዕዛዝ አስቀድሞ ጥቅም ላይ ውሏል። ለዚህ ትዕዛዝ የከፈሉትን ክፍያ የግብይት ቁጥር ያስገቡ። |
| `pay.tryLater` | We couldn't check right now. Your order is safe. Try again in a moment. | አሁን መፈተሽ አልተቻለም። ትዕዛዝዎ ደህና ነው። ትንሽ ቆይተው እንደገና ይሞክሩ። |
| `pay.cancelBody` | Your items go back to your cart. Only cancel if you have not sent any money. | እቃዎችዎ ወደ ጋሪዎ ይመለሳሉ። ምንም ገንዘብ ካልላኩ ብቻ ይሰርዙ። |
| `pay.cancelFailed` | Couldn't cancel the order. It may already be paid or being checked. | ትዕዛዙን መሰረዝ አልተቻለም። ምናልባት ተከፍሏል ወይም እየተረጋገጠ ነው። |
| `order.note.payment_mismatch` | Your transfer doesn't match the order total. We're reviewing it, so please don't pay again. | ዝውውርዎ ከትዕዛዙ ጠቅላላ ጋር አይመሳሰልም። እየገመገምነው ነው፤ እባክዎ እንደገና አይክፈሉ። |
| `deposit.exactNote` | Send this exact amount. A different amount cannot be added automatically. | ይህንኑ መጠን በትክክል ይላኩ። የተለየ መጠን በራስ-ሰር መጨመር አይቻልም። |
| `deposit.cancelBody` | This deposit will be cancelled. If you've already sent money, don't cancel: enter the reference instead. | ይህ ገቢ ይሰረዛል። ገንዘብ አስቀድመው ከላኩ አይሰርዙ፤ በምትኩ የግብይት ቁጥሩን ያስገቡ። |
| `deposit.mismatchBody` | We found your transfer, but not for {amount}. Nothing was added to your balance. We'll review it. | ዝውውርዎን አግኝተነዋል፣ ግን ለ{amount} አይደለም። ወደ ቀሪ ሂሳብዎ ምንም አልተጨመረም። እንገመግመዋለን። |
| `withdraw.note` | The amount leaves your balance right away. We send it to the account above after checking, usually within a day. If we can't, it goes back to your balance and we tell you why. | መጠኑ ወዲያውኑ ከቀሪ ሂሳብዎ ይወጣል። ከተመለከትን በኋላ፣ ብዙውን ጊዜ በአንድ ቀን ውስጥ፣ ከላይ ወዳለው መለያ እንልካለን። ካልቻልን ወደ ቀሪ ሂሳብዎ ይመለሳል፤ ምክንያቱንም እንነግርዎታለን። |
| `withdraw.confirmBody` | Send {amount} to {provider} {account}? Check the number: money sent to a wrong number cannot be recovered. | {amount} ወደ {provider} {account} ይላክ? ቁጥሩን ያረጋግጡ፦ ወደ ተሳሳተ ቁጥር የተላከ ገንዘብ መመለስ አይቻልም። |
| `withdraw.doneBody` | {amount} is on hold. We will send it to {provider} {account} soon. | {amount} ተይዟል። በቅርቡ ወደ {provider} {account} እንልካለን። |

## 2. Translated by Claude and live in the app: a native glance recommended (181)

Short labels, statuses, buttons and plain messages. Older Amharic strings (written before this pass) are not listed.

| Key | English | Amharic |
|---|---|---|
| `cart.title` | Cart | ጋሪ |
| `cart.empty` | Your cart is empty | ጋሪዎ ባዶ ነው |
| `cart.emptyBody` | Add packs from a game page, then check out here. | ከጨዋታ ገጽ ጥቅሎችን ወደ ጋሪ ያክሉ፣ ከዚያ እዚህ ክፍያ ይፈጽሙ። |
| `cart.browse` | Browse games | ጨዋታዎችን ይመልከቱ |
| `cart.add` | Add to cart | ወደ ጋሪ ጨምር |
| `cart.added` | Added to cart | ወደ ጋሪ ተጨምሯል |
| `cart.remove` | Remove | አስወግድ |
| `cart.qty` | Quantity | ብዛት |
| `cart.total` | Total | ጠቅላላ |
| `cart.checkout` | Check out | ክፍያ ፈጽም |
| `cart.unavailable` | No longer available | ከዚህ በኋላ አይገኝም |
| `cart.unavailableBody` | Remove it to continue. | ለመቀጠል ያስወግዱት። |
| `cart.fixFirst` | Fix these first: | መጀመሪያ እነዚህን ያስተካክሉ፦ |
| `cart.problem.fill_fields` | enter the ID | መለያውን ያስገቡ |
| `cart.problem.checking` | checking the ID… | መለያውን በመፈተሽ ላይ… |
| `cart.problem.invalid_id` | the ID isn't valid | መለያው ትክክል አይደለም |
| `cart.problem.check_failed` | couldn't check the ID, tap Retry | መለያውን መፈተሽ አልተቻለም፣ እንደገና ይሞክሩ |
| `cart.problem.check_expired` | the ID check ran out, check it again | የፍተሻው ጊዜ አልፏል፣ እንደገና ይፈትሹ |
| `cart.problem.confirm_id` | tick that you checked the ID | መለያዎን እንደፈተሹ ምልክት ያድርጉ |
| `cart.problem.wrong_region` | this pack isn't for that account's region | ይህ ጥቅል ለዚያ መለያ ክልል አይደለም |
| `cart.problem.region_unknown` | the account's region couldn't be confirmed | የመለያው ክልል ሊረጋገጥ አልቻለም |
| `cart.problem.unavailable` | no longer available | ከዚህ በኋላ አይገኝም |
| `cart.problem.package_unavailable` | not available | አይገኝም |
| `cart.problem.choose_package` | not available | አይገኝም |
| `cart.dropped` | These items are no longer for sale and were removed: {items} | እነዚህ እቃዎች ከዚህ በኋላ አይሸጡም፤ ተወግደዋል፦ {items} |
| `cart.fixIds` | These items need their player ID checked again: {items} | የእነዚህ እቃዎች የተጫዋች መለያ እንደገና መፈተሽ አለበት፦ {items} |
| `cart.checkoutFailed` | Couldn't start checkout. Check your connection and try again. | ክፍያውን መጀመር አልተቻለም። ግንኙነትዎን ያረጋግጡና እንደገና ይሞክሩ። |
| `cart.loadError` | Couldn't load your cart. Check your connection and try again. | ጋሪዎን መጫን አልተቻለም። ግንኙነትዎን ያረጋግጡና እንደገና ይሞክሩ። |
| `cart.pending` | You have an order waiting for payment. | ክፍያ የሚጠብቅ ትዕዛዝ አለዎት። |
| `pay.title` | Pay | ክፍያ |
| `pay.amount` | Send exactly | በትክክል ይላኩ |
| `pay.method` | Pay with | የመክፈያ መንገድ |
| `pay.telebirr` | Telebirr | ቴሌብር |
| `pay.sendTo` | Send to | የሚላክበት |
| `pay.accountName` | Account name | የመለያ ስም |
| `pay.accountNumber` | Account number | የመለያ ቁጥር |
| `pay.ref.telebirr` | Telebirr transaction number | የቴሌብር የግብይት ቁጥር |
| `pay.ref.cbe` | CBE transaction ID | የCBE የግብይት መለያ |
| `pay.refHint.telebirr` | Find it in your Telebirr receipt or SMS. | በቴሌብር ደረሰኝዎ ወይም በአጭር መልዕክትዎ (SMS) ውስጥ ያገኙታል። |
| `pay.refHint.cbe` | Find it on your CBE receipt or SMS. It starts with FT. | በCBE ደረሰኝዎ ወይም በአጭር መልዕክትዎ ላይ ያገኙታል። በFT ይጀምራል። |
| `pay.refRequired` | Enter the reference from your payment receipt. | ከክፍያ ደረሰኝዎ የግብይት ቁጥሩን ያስገቡ። |
| `pay.submit` | Verify payment | ክፍያውን አረጋግጥ |
| `pay.verifying` | Checking your payment… | ክፍያዎን በማረጋገጥ ላይ… |
| `pay.wait` | Still checking. This can take a moment. | አሁንም በማረጋገጥ ላይ ነው። ትንሽ ሊወስድ ይችላል። |
| `pay.paidTitle` | Payment confirmed | ክፍያ ተረጋግጧል |
| `pay.paidBody` | We received {amount}. Thank you. | {amount} ተቀብለናል። አመሰግናለን። |
| `pay.mismatchTitle` | We're reviewing your payment | ክፍያዎን እየገመገምን ነው |
| `pay.closed` | This order is no longer waiting for payment. | ይህ ትዕዛዝ ከዚህ በኋላ ክፍያ አይጠብቅም። |
| `pay.cancel` | Cancel this order | ትዕዛዙን ሰርዝ |
| `pay.cancelTitle` | Cancel this order? | ትዕዛዙ ይሰረዝ? |
| `pay.cancelled` | Order cancelled. Your items are back in your cart. | ትዕዛዙ ተሰርዟል። እቃዎችዎ ወደ ጋሪዎ ተመልሰዋል። |
| `pay.items` | In this order | በዚህ ትዕዛዝ ውስጥ |
| `pay.viewOrders` | View my orders | ትዕዛዞቼን ተመልከት |
| `pay.loadError` | Couldn't load this order. Check your connection and try again. | ይህን ትዕዛዝ መጫን አልተቻለም። ግንኙነትዎን ያረጋግጡና እንደገና ይሞክሩ። |
| `status.pending_payment` | Awaiting payment | ክፍያ በመጠበቅ ላይ |
| `status.paid` | Paid | ተከፍሏል |
| `status.payment_mismatch` | Under review | በመገምገም ላይ |
| `status.cancelled` | Cancelled | ተሰርዟል |
| `order.note.pending_payment` | Waiting for your payment. Open it to finish paying. | ክፍያዎን እየጠበቅን ነው። ለመጨረስ ይክፈቱት። |
| `order.note.paid` | Payment confirmed. | ክፍያ ተረጋግጧል። |
| `order.note.cancelled` | This order was cancelled. | ይህ ትዕዛዝ ተሰርዟል። |
| `order.items` | Items | እቃዎች |
| `tx.withdrawal` | Withdrawal | ወጪ |
| `product.buyNow` | Buy now | አሁን ግዛ |
| `wallet.title` | Wallet | ቦርሳ |
| `wallet.balance` | Balance | ቀሪ ሂሳብ |
| `wallet.open` | Wallet, balance {amount} | ቦርሳ፣ ቀሪ ሂሳብ {amount} |
| `wallet.unavailable` | Wallet, balance unavailable | ቦርሳ፣ ቀሪ ሂሳብ አይገኝም |
| `wallet.add` | Add money | ገንዘብ ጨምር |
| `wallet.deposit` | Deposit | ገንዘብ አስገባ |
| `wallet.withdraw` | Withdraw | ገንዘብ አውጣ |
| `wallet.history` | History | ታሪክ |
| `wallet.noHistory` | No transactions yet. | ገና ምንም ግብይት የለም። |
| `wallet.after` | Balance {balance} | ቀሪ ሂሳብ {balance} |
| `wallet.openDeposit` | Deposit of {amount} is waiting for your payment | የ{amount} ገቢ ክፍያዎን እየጠበቀ ነው |
| `wallet.openDepositBody` | Send the money, then enter the reference to add it to your balance. | ገንዘቡን ይላኩ፣ ከዚያ ወደ ቀሪ ሂሳብዎ ለመጨመር የግብይት ቁጥሩን ያስገቡ። |
| `wallet.continue` | Continue | ቀጥል |
| `wallet.withdrawals` | Your withdrawals | የገንዘብ ማውጫ ጥያቄዎችዎ |
| `wallet.wd.pending` | Pending | በመጠበቅ ላይ |
| `wallet.wd.approved` | Approved | ጸድቋል |
| `wallet.wd.paid` | Paid | ተከፍሏል |
| `wallet.wd.declined` | Declined | ውድቅ ተደርጓል |
| `wallet.declinedNote` | Returned to your balance. Reason: {note} | ወደ ቀሪ ሂሳብዎ ተመልሷል። ምክንያት፦ {note} |
| `wallet.err.invalid_amount` | That amount is not allowed. | ይህ መጠን አይፈቀድም። |
| `wallet.err.invalid_provider` | Choose Telebirr or CBE. | ቴሌብር ወይም CBE ይምረጡ። |
| `wallet.err.invalid_account` | That account number doesn't look right. Check it and try again. | የመለያ ቁጥሩ ትክክል አይመስልም። ያረጋግጡና እንደገና ይሞክሩ። |
| `wallet.err.insufficient_balance` | You don't have enough balance for that. | ለዚህ በቂ ቀሪ ሂሳብ የለዎትም። |
| `wallet.err.deposit_open` | You already have a deposit waiting for payment. | ክፍያ የሚጠብቅ ገቢ አስቀድሞ አለዎት። |
| `wallet.err.too_many_pending` | You have too many withdrawals waiting. Wait for some to be handled first. | ብዙ የገንዘብ ማውጫ ጥያቄዎች በመጠበቅ ላይ ናቸው። መጀመሪያ አንዳንዶቹ እስኪስተናገዱ ይጠብቁ። |
| `wallet.err.unauthorized` | Please sign in again. | እባክዎ እንደገና ይግቡ። |
| `wallet.err.unavailable` | Couldn't reach the server. Check your connection and try again. | አገልጋዩን ማግኘት አልተቻለም። ግንኙነትዎን ያረጋግጡና እንደገና ይሞክሩ። |
| `deposit.title` | Deposit | ገንዘብ አስገባ |
| `deposit.lead` | Add money to your balance by Telebirr or CBE. We add it as soon as your payment is verified. | ወደ ቀሪ ሂሳብዎ በቴሌብር ወይም በCBE ገንዘብ ይጨምሩ። ክፍያዎ እንደተረጋገጠ እንጨምራለን። |
| `deposit.amount` | Amount (Br) | መጠን (ብር) |
| `deposit.quick` | Quick amounts | ፈጣን መጠኖች |
| `deposit.start` | Continue | ቀጥል |
| `deposit.problem.required` | Enter an amount. | መጠን ያስገቡ። |
| `deposit.problem.min` | The smallest deposit is {min}. | ትንሹ ገቢ {min} ነው። |
| `deposit.problem.max` | The largest deposit is {max}. | ትልቁ ገቢ {max} ነው። |
| `deposit.sendExactly` | Send exactly | በትክክል ይላኩ |
| `deposit.cancel` | Change the amount | መጠኑን ቀይር |
| `deposit.cancelTitle` | Change the amount? | መጠኑ ይቀየር? |
| `deposit.cancelFailed` | Couldn't cancel it. Try again. | መሰረዝ አልተቻለም። እንደገና ይሞክሩ። |
| `deposit.paidTitle` | Deposit received | ገቢ ተቀብለናል |
| `deposit.paidBody` | {amount} was added to your balance. | {amount} ወደ ቀሪ ሂሳብዎ ተጨምሯል። |
| `deposit.mismatchTitle` | The amount doesn't match | መጠኑ አይመሳሰልም |
| `deposit.done` | Done | ተጠናቋል |
| `withdraw.title` | Withdraw | ገንዘብ አውጣ |
| `withdraw.amount` | Amount (Br) | መጠን (ብር) |
| `withdraw.to` | Send my money to | ገንዘቤ የሚላክበት |
| `withdraw.account.telebirr` | Your Telebirr number | የቴሌብር ቁጥርዎ |
| `withdraw.account.cbe` | Your CBE account number | የCBE መለያ ቁጥርዎ |
| `withdraw.account.required` | Enter the account to send it to. | የሚላክበትን መለያ ያስገቡ። |
| `withdraw.account.invalid` | That number doesn't look right. | ቁጥሩ ትክክል አይመስልም። |
| `withdraw.accountHint.telebirr` | The phone number registered with Telebirr, like 0911 22 33 44. | በቴሌብር የተመዘገበው ስልክ ቁጥር፣ ለምሳሌ 0911 22 33 44። |
| `withdraw.accountHint.cbe` | Your 13-digit CBE account number. | የ13 አሃዝ የCBE መለያ ቁጥርዎ። |
| `withdraw.problem.required` | Enter an amount. | መጠን ያስገቡ። |
| `withdraw.problem.min` | The smallest withdrawal is {min}. | ትንሹ የማውጫ መጠን {min} ነው። |
| `withdraw.problem.balance` | That is more than your balance ({balance}). | ይህ ከቀሪ ሂሳብዎ ({balance}) ይበልጣል። |
| `withdraw.submit` | Request withdrawal | ማውጫ ጠይቅ |
| `withdraw.confirmTitle` | Send to this account? | ወደዚህ መለያ ይላክ? |
| `withdraw.confirm` | Request it | ጠይቅ |
| `withdraw.doneTitle` | Request sent | ጥያቄው ተልኳል |
| `cart.payWallet` | Paid instantly from your wallet ({balance} available). | ወዲያውኑ ከቦርሳዎ ይከፈላል (ቀሪ ሂሳብ {balance})። |
| `cart.payBank` | Your wallet ({balance}) doesn't cover this, so you'll pay by Telebirr or CBE next. | ቦርሳዎ ({balance}) ይህን አይሸፍንም፤ ስለዚህ በቀጣይ በቴሌብር ወይም በCBE ይከፍላሉ። |
| `cart.checkoutWallet` | Pay {amount} from wallet | ከቦርሳ {amount} ክፈል |
| `pay.wallet` | Pay {amount} from wallet | ከቦርሳ {amount} ክፈል |
| `pay.walletOr` | Your wallet covers this order | ቦርሳዎ ይህን ትዕዛዝ ይሸፍናል |
| `pay.walletFailed` | Couldn't pay from the wallet. Your balance may have changed. Nothing was taken. | ከቦርሳ መክፈል አልተቻለም። ቀሪ ሂሳብዎ ተቀይሮ ሊሆን ይችላል። ምንም አልተወሰደም። |
| `pay.paidWalletBody` | Paid from your wallet: {amount}. | ከቦርሳዎ ተከፍሏል፦ {amount}። |
| `auth.welcome` | Welcome! | እንኳን ደህና መጡ! |
| `auth.welcomeSub` | Top up games and gift cards in seconds, paid in birr. | ጨዋታዎችንና የስጦታ ካርዶችን በሰከንዶች ውስጥ ይሙሉ፣ በብር ይክፈሉ። |
| `auth.signUp` | Sign up | ተመዝገብ |
| `auth.login` | Login | ግባ |
| `auth.welcomeBack` | Welcome Back! | እንኳን በደህና ተመለሱ! |
| `auth.loginSub` | Log in to top up in seconds | በሰከንዶች ውስጥ ለመሙላት ይግቡ |
| `auth.email` | Email address | ኢሜይል አድራሻ |
| `auth.password` | Password | የይለፍ ቃል |
| `auth.passwordPlaceholder` | Your password | የይለፍ ቃልዎ |
| `auth.passwordNew` | At least 8 characters | ቢያንስ 8 ቁምፊዎች |
| `auth.wrongCreds` | Wrong email or password. | ኢሜይሉ ወይም የይለፍ ቃሉ የተሳሳተ ነው። |
| `auth.signInFailed` | Sign in failed. | መግባት አልተቻለም። |
| `auth.confirmFirst` | Please confirm your email first, then log in. | እባክዎ መጀመሪያ ኢሜይልዎን ያረጋግጡ፣ ከዚያ ይግቡ። |
| `auth.noAccount` | Don't have an account? | መለያ የለዎትም? |
| `auth.haveAccount` | Already have an account? | መለያ አለዎት? |
| `auth.orLogin` | or log in with | ወይም በዚህ ይግቡ |
| `auth.orSignUp` | or sign up with | ወይም በዚህ ይመዝገቡ |
| `auth.createAccount` | Create Account | መለያ ፍጠር |
| `auth.createSub` | Enter your personal data | መረጃዎን ያስገቡ |
| `auth.name` | Your name | ስምዎ |
| `auth.namePlaceholder` | e.g. Abebe | ለምሳሌ አበበ |
| `auth.nameShort` | Display name must be at least 2 characters. | ስም ቢያንስ 2 ፊደላት መሆን አለበት። |
| `auth.badEmail` | Enter a valid email address. | ትክክለኛ ኢሜይል አድራሻ ያስገቡ። |
| `auth.passwordShort` | Password must be at least 8 characters. | የይለፍ ቃል ቢያንስ 8 ቁምፊዎች መሆን አለበት። |
| `auth.signUpFailed` | Sign up failed. | መመዝገብ አልተቻለም። |
| `auth.alreadyRegistered` | That email already has an account. Try signing in. | ይህ ኢሜይል አስቀድሞ መለያ አለው። ለመግባት ይሞክሩ። |
| `auth.checkEmail` | Check your email | ኢሜይልዎን ይመልከቱ |
| `auth.sentLink` | We sent a confirmation link to {email} | የማረጋገጫ አገናኝ ወደ {email} ልከናል |
| `auth.openLink` | Open the link to activate your account, then log in. | መለያዎን ለማንቃት አገናኙን ይክፈቱ፣ ከዚያ ይግቡ። |
| `auth.goLogin` | Go to login | ወደ መግቢያ ሂድ |
| `auth.google` | Continue with Google | በGoogle ቀጥል |
| `auth.apple` | Continue with Apple | በApple ቀጥል |
| `auth.notReady` | Google and Apple sign-in need a development build. Coming next. | የGoogle እና Apple መግቢያ የልማት ግንባታ (development build) ያስፈልጋቸዋል። በቅርቡ ይመጣል። |
| `auth.hidePassword` | Hide password | የይለፍ ቃል ደብቅ |
| `auth.showPassword` | Show password | የይለፍ ቃል አሳይ |
| `splash.tagline` | Diamonds, UC, gift cards and more. ⏎ Delivered in seconds. | ዳይመንድ፣ UC፣ የስጦታ ካርዶች እና ሌሎችም። ⏎ በሰከንዶች ውስጥ ይላካል። |
| `splash.continue` | Continue | ቀጥል |
| `receipt.title` | Receipt | ደረሰኝ |
| `receipt.paymentMethod` | Paid with | የተከፈለበት መንገድ |
| `receipt.wallet` | Wallet | ቦርሳ |
| `receipt.reference` | Transaction number | የግብይት ቁጥር |
| `receipt.paidOn` | Paid on | የተከፈለበት ቀን |
| `receipt.download` | Download receipt | ደረሰኝ አውርድ |
| `receipt.shareTitle` | Share receipt | ደረሰኝ አጋራ |
| `receipt.failed` | Couldn't make the receipt. Try again. | ደረሰኙን ማዘጋጀት አልተቻለም። እንደገና ይሞክሩ። |
| `receipt.unavailable` | Sharing isn't available on this device. | በዚህ መሳሪያ ማጋራት አይቻልም። |
| `receipt.thanks` | Thank you for your order. | ትዕዛዝዎን ስለሰጡን እናመሰግናለን። |
| `receipt.notYet` | A receipt appears here once your payment is confirmed. | ክፍያዎ ሲረጋገጥ ደረሰኝ እዚህ ይታያል። |
| `pay.tutorial` | How to pay | እንዴት እንደሚከፍሉ |
| `pay.tutorialImage` | Picture {n} of {total} | ስዕል {n} ከ{total} |
| `product.idFirst` | Check your ID above first, then choose an amount. | መጀመሪያ ከላይ መለያዎን ያረጋግጡ፣ ከዚያ መጠን ይምረጡ። |
