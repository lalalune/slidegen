// example call

// import OpenAI from "openai";
// import { writeFile } from "fs/promises";

// const client = new OpenAI();

// const img = await client.images.generate({
//   model: "gpt-image-1",
//   prompt: "A cute baby sea otter",
//   n: 1,
//   size: "1536x1024"
// });

// const imageBuffer = Buffer.from(img.data[0].b64_json, "base64");
// await writeFile("output.png", imageBuffer);


// response

// {
//     "created": 1713833628,
//     "data": [
//       {
//         "b64_json": "..."
//       }
//     ],
//     "usage": {
//       "total_tokens": 100,
//       "input_tokens": 50,
//       "output_tokens": 50,
//       "input_tokens_details": {
//         "text_tokens": 10,
//         "image_tokens": 40
//       }
//     }
//   }

// Step 1: Read the prompt.txt if slides.json doesn't exist

// Step 2: Use gpt-4o to generate a list of slides from the prompt as XML, with title, text, imageDescription

// Step 3: Create a /slides folder

// Step 4: For each imageDescription, generate 3 images (constant default 3), and save them in the /slides folder

import { config } from "dotenv";

config();

import OpenAI from "openai";
import { writeFile, readFile, access, mkdir } from "fs/promises";
import { parseStringPromise } from "xml2js";
import path from "path";
import { fileURLToPath } from 'url'; // To get __dirname in ES modules

// Configuration
const RESEARCH_FILE = "research.txt";
const SLIDES_JSON_FILE = "slides.json";
const IMAGES_DIR = "images";
const SLIDE_GENERATION_MODEL = "gpt-4o";
const IMAGE_GENERATION_MODEL = "gpt-image-1";
const IMAGE_SIZE = "1536x1024";
const EXPECTED_SLIDES_COUNT = 10;
const MAX_IMAGE_RETRIES = 3;
const INITIAL_IMAGE_RETRY_DELAY_MS = 1000;

// --- Helper Functions ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const client = new OpenAI();

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

// --- Slide Generation ---
async function generateSlidesFromResearch(researchText) {
  const prompt = `    Research Text:
    ---
    ${researchText}
    ---

    Based on the above research text, generate exactly ${EXPECTED_SLIDES_COUNT} slides for a presentation.
    Format the output STRICTLY as XML, starting with <slides> and containing ${EXPECTED_SLIDES_COUNT} <slide> elements.
    Each <slide> element MUST contain ONLY <title>, <text>, and <imageDescription> tags.
    The <text> should be a few talking points, brief concise jumping off bullet points for the speaker, and include any interesting facts or quotes from the research.
    The <imageDescription> should be a very detailed visual prompt, describing an ornate image slide with the text as brief bullet points naturally embedded in the scene, for example the text can be on billboards, television screens, chalkboards, slogans on street signs or shirts, etc. The images should be based on the slide's content and follow the style of the image prompt, telling the story of the slide. Do not add any commentary before or after the XML structure.

    Be extremely detailed, and try to describe where in the image any bullet points to text goes and be extremely specific in every artistic direction.

    IMPORTANT: Ensure all XML is valid with no special characters or entities that could cause parsing errors.

    XML Output:`;

  try {
    const response = await client.chat.completions.create({
      model: SLIDE_GENERATION_MODEL,
      messages: [{ role: "user", content: prompt }],
    });

    let xmlContent = response.choices[0]?.message?.content?.trim();
    if (!xmlContent) throw new Error("Received empty response from GPT-4o.");

    console.log("=== DEBUG: Raw GPT-4o Response ===");
    console.log(xmlContent);
    console.log("=== END Raw Response ===");

    const xmlStartIndex = xmlContent.indexOf('<slides>');
    const xmlEndIndex = xmlContent.lastIndexOf('</slides>');

    if (xmlStartIndex === -1 || xmlEndIndex === -1) {
        console.warn("Could not find <slides>...</slides> tags. Attempting to parse the whole response as XML.");
        const firstTag = xmlContent.indexOf('<');
        const lastTag = xmlContent.lastIndexOf('>');
        if (firstTag !== -1 && lastTag !== -1) {
            xmlContent = xmlContent.substring(firstTag, lastTag + 1);
        } else {
             throw new Error(`No XML structure found in GPT response. Response content:n${response.choices[0]?.message?.content}`);
        }
    } else {
         xmlContent = xmlContent.substring(xmlStartIndex, xmlEndIndex + '</slides>'.length);
    }

    console.log("=== DEBUG: Extracted XML ===");
    console.log(xmlContent);
    console.log("=== END Extracted XML ===");

    // Clean up common XML issues - only fix unescaped ampersands
    xmlContent = xmlContent
      .replace(/&(?!amp;|lt;|gt;|quot;|apos;|#[0-9]+;|#x[0-9a-fA-F]+;)/g, '&amp;'); // Fix unescaped ampersands

    console.log("=== DEBUG: Cleaned XML ===");
    console.log(xmlContent);
    console.log("=== END Cleaned XML ===");

    const parsedResult = await parseStringPromise(xmlContent, {
        explicitArray: false, trim: true, tagNameProcessors: [(name) => name.toLowerCase()]
    });

    if (!parsedResult || !parsedResult.slides || !parsedResult.slides.slide) {
        throw new Error(`Unexpected XML structure after parsing. Expected 'slides.slide'. Got: ${JSON.stringify(parsedResult)}`);
    }

    let slidesArray = Array.isArray(parsedResult.slides.slide) ? parsedResult.slides.slide : [parsedResult.slides.slide];

     if (slidesArray.length !== EXPECTED_SLIDES_COUNT) {
         console.warn(`Warning: Expected ${EXPECTED_SLIDES_COUNT} slides, but generated ${slidesArray.length}. Proceeding with available slides.`);
     }

    const slidesData = slidesArray.map((slide, index) => {
        const isValid = !!(slide.title && slide.text && slide.imagedescription);
        if (!isValid) {
            console.warn(`Slide ${index + 1} is missing title, text, or imageDescription. It will be marked as invalid.`);
        }
        return { ...slide, slideNumber: index + 1, isValid };
    });

    const slidesFilePath = path.join(__dirname, SLIDES_JSON_FILE);
    await writeFile(slidesFilePath, JSON.stringify(slidesData, null, 2));
    console.log(`Slides data saved to ${slidesFilePath}`);
    return slidesData;
  } catch (error) {
    console.error("Error generating or parsing slides:", error);
    console.error("If this is an XML parsing error, check the debug output above for the actual XML content.");
    throw error;
  }
}

// --- Image Generation ---
async function generateImageWithRetry(imageDescription, slideText, slideNumber) {
  let retries = 0;
  const imagePath = path.join(__dirname, IMAGES_DIR, `slide_${slideNumber}_image.png`);

  // Use imageDescription as-is since it already contains text naturally embedded
  const imagePrompt = imageDescription;

  while (retries <= MAX_IMAGE_RETRIES) {
    try {
      // Log shortened prompt to avoid overly long logs
      const displayPrompt = imagePrompt.length > 150 ? imagePrompt.substring(0, 147) + "..." : imagePrompt;
      console.log(`Generating image for slide ${slideNumber} (Attempt ${retries + 1}/${MAX_IMAGE_RETRIES + 1})... Prompt: "${displayPrompt}"`);

      const img = await client.images.generate({
        model: IMAGE_GENERATION_MODEL,
        prompt: imagePrompt,
        n: 1,
        size: IMAGE_SIZE,
      });

      const b64Json = img.data?.[0]?.b64_json;
      if (!b64Json) throw new Error("Invalid image data received (missing b64_json).");

      await writeFile(imagePath, Buffer.from(b64Json, "base64"));
      console.log(`Image for slide ${slideNumber} saved to ${imagePath}`);
      return { success: true, path: imagePath };
    } catch (error) {
      retries++;
      console.error(`Error for slide ${slideNumber} (Attempt ${retries}): ${error.message || error}`);
      if (retries > MAX_IMAGE_RETRIES) {
        console.error(`Failed for slide ${slideNumber} after ${MAX_IMAGE_RETRIES + 1} attempts.`);
        return { success: false, error: error.message || error };
      }
      const waitTime = INITIAL_IMAGE_RETRY_DELAY_MS * Math.pow(2, retries - 1);
      console.log(`Retrying slide ${slideNumber} in ${waitTime / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
}

// --- Main Execution ---
async function main() {
  let slides;
  const slidesJsonPath = path.join(__dirname, SLIDES_JSON_FILE);
  const researchPath = path.join(__dirname, RESEARCH_FILE);
  const imagesPath = path.join(__dirname, IMAGES_DIR);

  if (await fileExists(slidesJsonPath)) {
    console.log(`Found existing ${SLIDES_JSON_FILE}. Loading slides.`);
    try {
      slides = JSON.parse(await readFile(slidesJsonPath, "utf-8"));
      if (!Array.isArray(slides) || !slides.length) throw new Error(`${SLIDES_JSON_FILE} is invalid/empty.`);
      console.log(`Loaded ${slides.length} slides.`);
      slides = slides.map((s, i) => ({ ...s, slideNumber: s.slideNumber || i + 1, isValid: !!(s.title && s.text && s.imagedescription) }));
    } catch (e) {
      console.error(`Error with ${slidesJsonPath}: ${e.message}. Fix or remove to regenerate.`);
      process.exit(1);
    }
  } else {
    console.log(`${SLIDES_JSON_FILE} not found. Generating from ${RESEARCH_FILE}.`);
    if (!(await fileExists(researchPath))) {
      console.error(`Error: ${RESEARCH_FILE} not found at ${researchPath}.`);
      process.exit(1);
    }
    try {
      slides = await generateSlidesFromResearch(await readFile(researchPath, "utf-8"));
      if (!slides || !slides.length) throw new Error("Slide generation failed or produced no slides.");
    } catch (e) {
      console.error(`Failed to generate slides: ${e.message}`);
      process.exit(1);
    }
  }

  const validSlides = slides.filter(s => s.isValid);
  if (!validSlides.length) {
    console.log("No valid slides to process. Exiting.");
    process.exit(0);
  }
  if (validSlides.length < slides.length) {
      console.warn(`${slides.length - validSlides.length} invalid slides found. Processing ${validSlides.length} valid slides.`);
  }

  if (!(await fileExists(imagesPath))) {
    console.log(`Creating images directory: ${imagesPath}`);
    await mkdir(imagesPath, { recursive: true });
  }

  // Step 4: Generate Images in Parallel
  console.log(`\nStarting image generation for ${validSlides.length} slides...`);
  const imagePromises = validSlides.map(slide =>
      // Pass the potentially empty string, generateImageWithRetry handles logging
      generateImageWithRetry(slide.imagedescription, slide.text, slide.slideNumber) // Pass slide.text
  );

  const results = await Promise.all(imagePromises);
  
  const successfulImages = results.filter(r => r?.success).length;
  console.log("n--- Image Generation Summary ---");
  console.log(`Total valid slides: ${validSlides.length}`);
  console.log(`Successfully generated images: ${successfulImages}`);
  if (validSlides.length - successfulImages > 0) {
    console.error(`Failed image generations: ${validSlides.length - successfulImages}`);
  }
  console.log("------------------------------nScript finished.");
}

main().catch(error => {
  console.error("n--- Unhandled Error ---", error.message || error, "-----------------------");
  process.exit(1);
});