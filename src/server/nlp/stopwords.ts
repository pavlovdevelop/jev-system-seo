// Function words that carry no topical meaning. Used to (a) ignore them when checking whether a page
// "contains" a keyword and (b) keep them out of mined phrases. Bulgarian + English, since Bulgarian
// pages routinely mix both.

const BG = `
а аз ако ала бе без беше би бил била били било били благодаря близо бъдат бъде бяха в вас ваш ваша ваше ваши вече
ви вие винаги все всеки всички всичко всяка във въпреки върху г ги го година години да дали два двама две двете ден
днес дни до добре докато дори досега доста друг друга други е едва един една едно ето за зад заедно заради засега
затова защо защото и из или им има имат иска й каза как каква какво както какъв като кога когато което които кой
който колко която къде където към ли м май ме между мен ми много мога могат може моля момента му н на над назад
най напред например нас не него нещо нея ни ние никой нито нищо но някои някой няколко няма обаче около освен
особено от отново още пак по повече повечето под поне поради после почти прави пред преди през при пък първо с са
сам само се сега си след следва сме според сред срещу сте съм със също т така такива такъв там твой те тези ти
то това тогава този той толкова точно трябва тук тъй тя тях у утре ч часа че често чрез ще щом я
нашата нашият нашите нашето наш наши ваша вашата вашият вашите вашето ни нас вас
`;

const EN = `
a about above after again all also am an and any are as at be because been before being below between both but by
can could did do does doing down during each few for from further had has have having he her here hers him his how
i if in into is it its just me more most my no nor not now of off on once only or other our out over own same she
should so some such than that the their them then there these they this those through to too under until up very
was we were what when where which while who whom why will with would you your
`;

export const STOPWORDS: ReadonlySet<string> = new Set(
  `${BG} ${EN}`
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean),
);

/** Words that start a question in Bulgarian or English. */
export const QUESTION_WORDS: ReadonlySet<string> = new Set([
  'как', 'какво', 'какъв', 'каква', 'какви', 'кой', 'коя', 'кое', 'кои', 'кога', 'къде', 'колко', 'защо', 'докога',
  'how', 'what', 'why', 'when', 'where', 'which', 'who', 'can', 'should', 'is', 'are', 'do', 'does',
]);
