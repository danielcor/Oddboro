# Terms of Use

Effective date: November 3, 2026

> **The short version.** Oddboro is open source software from New Altitude, Inc. The Apache License 2.0 governs the code, and nothing here takes away what that license gives you. These terms govern this website, the project's services, and how you use the software with other people's services. You run the software on your own computer, under your own Claude account, and you are responsible for what you approve or allow your Odds to do. AI output can be wrong, so check it before you rely on it. The Oddboro name and logo belong to New Altitude, so a fork needs its own name. The software comes as is, without warranty, and our liability is limited. A licensed attorney should read these terms with you if anything turns on them.

## 1. Acceptance

These Terms of Use (the "Terms") are an agreement between you and New Altitude, Inc. ("New Altitude", "we", "us"). They apply when you:

- visit oddboro.com or any of its subdomains (the "Site");
- download, install, run or contribute to the Oddboro software (the "Software"); or
- use any service New Altitude offers under the Oddboro name (the "Services").

By doing any of those, you accept these Terms. If you do not accept them, do not use the Site, the Software or the Services. If you use them on behalf of a company or another person, you confirm that you have authority to bind them, and "you" means them too.

You must be old enough to form a binding contract where you live, and at least 13 (or 16 where the law sets that age). The Software and Site are not directed to children.

## 2. What Oddboro is

Oddboro is a virtual office for one person. Its AI workers, called Odds, work on a pixel-art floor on your computer, and where each one stands tells you what it is doing. The Software runs entirely on your own computer, keeps its records in a database on your computer, and reaches other services (Anthropic and the tools you connect) only when you set that up and only under your own accounts. Our [Privacy Policy](/privacy) explains where data goes, and it is part of these Terms.

New Altitude publishes the Software. We do not operate it for you, host it for you, or see what it does on your computer.

## 3. The open source license

### The code

The Software's code is licensed under the Apache License 2.0 (the "License"). The full text is in the `LICENSE` file in the repository, and attribution travels in the `NOTICE` file. The License, not these Terms, governs your use, copying, modification and distribution of the code. **Nothing in these Terms limits, conditions or takes away any right the License grants you.** If these Terms and the License conflict about the code, the License wins.

These Terms govern what the License does not: the Site, the Services, the Oddboro trademarks, and your responsibilities when you use the Software with other people's services.

### Contributions

Contributions to the repository come in under the License and the Developer Certificate of Origin, as `CONTRIBUTING.md` describes. Each commit in a pull request carries a sign-off. By contributing, you confirm the DCO's statements for that contribution.

### The audio assets

The audio files in `apps/office/static/audio/` and `apps/site/static/audio/` are **not** licensed under the Apache License 2.0. New Altitude, Inc. holds them, and the `LICENSE-ASSETS` file in the repository governs them. They are provided for demonstration purposes only, as part of the office's music player. You may not extract, redistribute, sell or use them commercially. A third party who wants to use that audio commercially must secure its own rights. If you fork the Software, remove the audio or replace it with your own.

## 4. Your responsibilities

The Software gives Odds the ability to read your information and, as far as you allow, act on it. You decide how far each Odd reaches, and you are responsible for how that access is used.

### Actions you approve or allow

Each Odd gets the access you give it. An Odd holds one permission level (Read, Draft or Act), and only you raise it. An Odd at Draft prepares work, and you approve the exact action before it happens. When you give an Odd write access to a tool and the Act level to use it, that grant is your standing approval for that Odd to use that tool without asking each time, until you lower its level or revoke the grant. Either way, **you are responsible for every action your Odds take**, including every draft you approve, every tool you connect, and every write grant you give. Review what an Odd proposes before you approve it, and give write access only where you accept the Odd acting without asking you first.

### Your accounts and other people's terms

You use the Software with your own Claude plan or Anthropic API key, and any other account you connect. You must comply with the terms of each of those services, including:

- Anthropic's [Consumer Terms](https://www.anthropic.com/legal/consumer-terms), [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) and [Usage Policy](https://www.anthropic.com/legal/aup), as they apply to you.

Those terms are between you and those companies. You are responsible for the fees, limits and rules of each account you connect, and for making sure your use of the Software with that account is permitted. If a service suspends or limits your account, that is between you and the service.

### Your computer and your data

You are responsible for the security of your computer, the accounts signed in on it, the data you put in the office, and the data you let the Software read. Keep backups of anything you cannot afford to lose. The Software stores everything locally, and if your disk fails or you delete `~/.oddboro`, we cannot recover it.

## 5. AI output may be wrong

Every Odd is AI. It can misread, misremember, invent, and act on a wrong assumption with complete confidence. In particular:

- A summary of your notes or files may miss something or get it wrong.
- A draft may say something you would not say.
- A proposed change, task or hire may be a bad idea.
- An Odd's report of what it did may not match what it did.

**Review AI output before you rely on it or let it act.** Do not use the Software as your only source for anything that matters, including legal, medical, financial, safety or employment decisions. We do not guarantee that any output is accurate, complete, current, appropriate or free of bias, and we are not responsible for decisions you make based on it.

## 6. Acceptable use

You may not use the Site, the Software or the Services to:

1. break any law, or help anyone else break one;
2. send spam or unsolicited bulk messages, or set up an Odd to do so;
3. harass, threaten, stalk, defame or abuse anyone;
4. access, read, change or act on an account, file or system that you are not authorized to access;
5. collect personal data about other people without a lawful basis and, where required, their consent;
6. infringe anyone's copyright, trademark, privacy, publicity or other rights;
7. build, train, test or operate anything intended to harm people, including malware, fraud, or impersonation;
8. interfere with the Site or the Services, probe or scan them for vulnerabilities without permission, or try to get around any limit;
9. pass off output from the Software as something a human wrote, where that would deceive someone to their detriment; or
10. do anything that would violate Anthropic's terms when the Software does it through your account.

The License lets you do a great deal with the code. It does not make any of the above lawful, and these restrictions on the Site and Services stand apart from the License.

## 7. Third-party services

The Software connects to services run by other companies, at your direction: Anthropic, GitHub (which also serves the app's updates and, once, when you turn on ledger search, the search model from Oddboro's own releases), the npm and PyPI registries, the MCP Registry, and any tool you connect through an Odd's request. We do not control those services. We are not responsible for their availability, their behavior, their terms, their fees, their privacy practices or anything they do with your data. A change on their side may break a feature on ours, and we may not be able to fix it.

Tools you add from the MCP Registry or elsewhere are software written by other people. Read what a tool does before you approve it, and treat it with the same care as anything else you install.

## 8. Trademarks

"Oddboro", the Oddboro logo, and the Oddboro pixel-art office identity are trademarks of New Altitude, Inc. (the "Marks"). The Apache License 2.0 (Section 6) grants no trademark rights, and neither do these Terms, except as this section says.

### What you may do

- Use the name "Oddboro" truthfully to refer to the Software, for example "a plugin for Oddboro" or "my office runs on Oddboro".
- Say that your work is "based on Oddboro" or "a fork of Oddboro", as long as that is accurate and your own name comes first.
- Use the Marks in reviews, articles, talks and other commentary.

### What you may not do

- Use the Marks as the name of a fork, modified version, product, service, company, app, domain name, social media account or package in a way that suggests it is Oddboro or comes from or is endorsed by New Altitude.
- Use the logo or the office identity on a modified version at all.
- Register or use any name, logo or domain confusingly similar to the Marks.

### If you fork

If you distribute a modified version of the Software, give it a different name and remove the Oddboro logo and name from the places a user would read them as the product's own (the title, the onboarding, the app icon, the domain). Attribution in `NOTICE`, in a credits page, or in a sentence like "based on Oddboro" stays and is welcome. If you are not sure whether a use is fine, ask at legal@oddboro.com.

Other names and logos on the Site belong to their owners.

## 9. Disclaimer of warranties

**THE SITE, THE SOFTWARE AND THE SERVICES ARE PROVIDED "AS IS" AND "AS AVAILABLE", WITHOUT WARRANTY OF ANY KIND. TO THE FULLEST EXTENT PERMITTED BY LAW, NEW ALTITUDE AND ITS CONTRIBUTORS DISCLAIM ALL WARRANTIES, EXPRESS, IMPLIED OR STATUTORY, INCLUDING ANY WARRANTY OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, NON-INFRINGEMENT, ACCURACY, QUIET ENJOYMENT, AND ANY WARRANTY ARISING FROM COURSE OF DEALING OR USAGE OF TRADE.**

**WITHOUT LIMITING THE ABOVE, WE DO NOT WARRANT THAT THE SOFTWARE WILL BE ERROR-FREE, SECURE OR UNINTERRUPTED; THAT ANY AI OUTPUT WILL BE ACCURATE, COMPLETE OR SUITABLE FOR ANY PURPOSE; THAT ANY ACTION AN ODD TAKES WILL BE THE ACTION YOU INTENDED; THAT ANY THIRD-PARTY SERVICE WILL KEEP WORKING WITH THE SOFTWARE; OR THAT YOUR DATA WILL NOT BE LOST. YOU USE THE SOFTWARE AT YOUR OWN RISK.**

Section 7 of the Apache License 2.0 states the same for the code, and it governs the code. Some jurisdictions do not allow some of these disclaimers, so some may not apply to you.

## 10. Limitation of liability

**TO THE FULLEST EXTENT PERMITTED BY LAW, NEW ALTITUDE, ITS OFFICERS, DIRECTORS, EMPLOYEES, AGENTS AND CONTRIBUTORS WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF PROFITS, REVENUE, DATA, GOODWILL OR BUSINESS OPPORTUNITY, ARISING OUT OF OR RELATED TO THE SITE, THE SOFTWARE, THE SERVICES, ANY AI OUTPUT, ANY ACTION TAKEN BY AN ODD, OR THESE TERMS, HOWEVER CAUSED AND UNDER ANY THEORY OF LIABILITY, EVEN IF WE WERE TOLD SUCH DAMAGES WERE POSSIBLE.**

**TO THE FULLEST EXTENT PERMITTED BY LAW, OUR TOTAL LIABILITY FOR ALL CLAIMS ARISING OUT OF OR RELATED TO THE SITE, THE SOFTWARE, THE SERVICES OR THESE TERMS WILL NOT EXCEED THE GREATER OF ONE HUNDRED US DOLLARS (US $100) OR THE AMOUNT YOU PAID NEW ALTITUDE FOR THE SERVICES IN THE TWELVE MONTHS BEFORE THE CLAIM AROSE.**

These limits apply together, and they are an essential part of the bargain between you and us: we give the Software away, and we could not do that without them. Section 8 of the Apache License 2.0 states the same for the code. Some jurisdictions do not allow some of these limits, so some may not apply to you. Nothing in these Terms limits liability that cannot be limited by law, including for death or personal injury caused by negligence, or for fraud.

## 11. Indemnity

You will defend, indemnify and hold harmless New Altitude and its officers, directors, employees, agents and contributors from any claim, demand, loss, liability, damage, cost or expense (including reasonable attorneys' fees) brought by a third party and arising out of or related to:

1. your use of the Site, the Software or the Services;
2. any action your Odds take, including any action you approved or allowed through a grant;
3. your breach of these Terms or of any law;
4. your violation of Anthropic's or any other third party's terms through your use of the Software; or
5. your violation of anyone's rights.

We may take over the defense of any matter you must indemnify, at our expense, and you will cooperate with us. You will not settle a claim in a way that admits fault or imposes an obligation on us without our written consent.

## 12. Changes to these Terms

We may change these Terms. When we do:

1. We update the effective date at the top.
2. We note the change in the release notes at [github.com/New-Altitude/Oddboro/releases](https://github.com/New-Altitude/Oddboro/releases) and on this page.
3. For a material change, we post a notice on the Site before it takes effect, and in the Software's release notes if the change concerns the Software.

Continuing to use the Site, the Software or the Services after a change takes effect means you accept the changed Terms. A change to these Terms never changes the License for code you already received under it.

## 13. Termination

You may stop using the Site, the Software and the Services at any time. Our Privacy Policy explains how to remove everything the Software stored.

We may suspend or end your access to the Site or the Services, with or without notice, if we reasonably believe you have broken these Terms or the law, or if we stop offering a Service. Ending access to the Site or a Service does not end your rights under the License to code you already have.

Sections 3 through 11 and 13 through 16 survive the end of these Terms.

## 14. Governing law and venue

These Terms are governed by the laws of the State of California, United States, without regard to its conflict of laws rules. The United Nations Convention on Contracts for the International Sale of Goods does not apply.

Any dispute arising out of or related to these Terms, the Site, the Software or the Services will be brought only in the state or federal courts located in San Francisco County, California, and you and we each consent to the personal jurisdiction of those courts. Either of us may seek an injunction or other equitable relief in any court with jurisdiction to protect intellectual property rights.

If you are a consumer in a jurisdiction whose law gives you the right to sue in your home courts or under your home law, nothing in this section takes that right away.

## 15. General terms

- **Severability.** If any part of these Terms is held unenforceable, the rest stays in force, and the unenforceable part is changed only as far as needed to make it enforceable.
- **Entire agreement.** These Terms, the Privacy Policy, and (for the code) the Apache License 2.0 and `LICENSE-ASSETS` are the entire agreement between you and New Altitude about the Site, the Software and the Services, and they replace any earlier agreement about them.
- **No waiver.** If we do not enforce a part of these Terms, that is not a waiver of our right to enforce it later. A waiver is effective only in writing and signed by us.
- **Assignment.** You may not assign or transfer these Terms without our written consent, and any attempt to do so is void. We may assign them to an affiliate or in connection with a merger, acquisition or sale of assets, with notice to you.
- **No third-party beneficiaries.** These Terms benefit only you and New Altitude, except that our contributors, officers, directors, employees and agents may enforce sections 9 through 11.
- **Force majeure.** We are not liable for any failure or delay caused by events outside our reasonable control.
- **Notices.** We may give you notice on the Site, in the repository, or at any email address you gave us. You give us notice at the addresses in section 16.
- **Headings and language.** Headings are for convenience only. The English version of these Terms governs any translation.
- **Export.** You will comply with export and sanctions laws that apply to your use of the Software.

## 16. Contact

- Legal notices and trademark questions: legal@oddboro.com
- Privacy: privacy@oddboro.com
- Post: New Altitude, Inc., 910 W Howe St, Seattle, WA 98119
