import React, { useState } from 'react';

interface EditorialImageProps {
  src: string;
  alt: string;
  className?: string;
  aspectClassName?: string;
  fallbackLabel?: string;
}

export const EditorialImage: React.FC<EditorialImageProps> = ({
  src,
  alt,
  className = 'w-full h-full object-cover',
  aspectClassName = 'relative overflow-hidden bg-[#19191F]',
  fallbackLabel,
}) => {
  const [failed, setFailed] = useState(false);

  return (
    <div className={aspectClassName}>
      {!failed && src ? (
        <img
          src={src}
          alt={alt}
          referrerPolicy="no-referrer"
          loading="lazy"
          onError={() => setFailed(true)}
          className={className}
        />
      ) : (
        <div
          className="w-full h-full flex flex-col items-center justify-center p-6 text-center"
          style={{
            background:
              'radial-gradient(circle at 30% 20%, rgba(233, 166, 160, 0.16), rgba(25, 25, 31, 0.95) 70%)',
          }}
        >
          <span className="font-serif-editorial italic text-2xl text-[#E9A6A0]">
            {fallbackLabel || alt}
          </span>
        </div>
      )}
    </div>
  );
};
