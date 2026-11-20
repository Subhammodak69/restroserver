async function sendOtp(phone, code) {
  if (process.env.NODE_ENV !== 'production') return { delivered: false, development: true };
  const endpoint=process.env.SMS_API_URL, key=process.env.SMS_API_KEY;
  if(!endpoint||!key){const error=new Error('SMS delivery is not configured.');error.status=503;throw error;}
  const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify({to:phone,message:`Your Ember & Spice verification code is ${code}. It expires in 5 minutes.`})});
  if(!response.ok){const error=new Error('Could not send the verification code. Try again.');error.status=502;throw error;}
  return {delivered:true};
}
module.exports={sendOtp};
